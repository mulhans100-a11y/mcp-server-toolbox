import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 1_000_000;
const MAX_UNTRACKED_DIFF_BYTES = 250_000;
const MAX_DIFF_PREVIEW_CHARS = 40_000;
const MAX_UNTRACKED_PREVIEW_FILES = 20;
const MAX_UNTRACKED_FILE_BYTES = 32_000;
const MAX_COMMIT_MESSAGE_LENGTH = 100;
const NO_CHANGES_MESSAGE = "Keine Änderungen zum Committen vorhanden.";
const CONVENTIONAL_COMMIT_PATTERN = /^[a-z][a-z0-9-]*(?:\([^\r\n()]+\))?!?: [^\r\n]+$/;

export interface GitAutoCommitInput {
  repositoryPath?: string;
  commitMessage?: string;
}

export interface GitAutoCommitResult {
  status: "clean" | "preview" | "committed";
  message: string;
  repositoryRoot: string;
  branch: string;
  gitStatus: string;
  diff: string;
  diffTruncated: boolean;
  commitId: string;
}

interface GitCommandOptions {
  allowDiffExitCode?: boolean;
  allowBufferTruncation?: boolean;
  maxBuffer?: number;
  timeout?: number;
}

interface GitCommandResult {
  stdout: string;
  truncated: boolean;
}

interface GitStatus {
  branch: string;
  porcelain: string;
  display: string;
}

export async function gitAutoCommit(input: GitAutoCommitInput): Promise<GitAutoCommitResult> {
  const configuredPath =
    input.repositoryPath ?? process.env.TOOLBOX_GIT_REPOSITORY ?? process.cwd();
  const requestedPath = resolve(configuredPath);
  let requestedPathInfo;
  try {
    requestedPathInfo = await stat(requestedPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Repository directory could not be accessed: ${detail}`);
  }
  if (!requestedPathInfo.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${requestedPath}`);
  }

  const rootOutput = await runGit(requestedPath, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = resolve(rootOutput.stdout.trim());
  const initialStatus = await readGitStatus(repositoryRoot);

  if (!initialStatus.porcelain.trim()) {
    return cleanResult(repositoryRoot, initialStatus);
  }

  if (input.commitMessage === undefined) {
    const preview = await createDiffPreview(repositoryRoot);
    return {
      status: "preview",
      message:
        "Changes found. Review the status and diff, create a Conventional Commit message, then call this tool again with commitMessage.",
      repositoryRoot,
      branch: initialStatus.branch,
      gitStatus: initialStatus.display,
      diff: preview.diff,
      diffTruncated: preview.truncated,
      commitId: "",
    };
  }

  validateCommitMessage(input.commitMessage);
  if (hasUnmergedPaths(initialStatus.porcelain)) {
    throw new Error("Resolve all merge conflicts before creating a commit.");
  }

  // Fail before staging anything when Git cannot create a commit identity.
  await runGit(repositoryRoot, ["var", "GIT_AUTHOR_IDENT"]);
  await runGit(repositoryRoot, ["var", "GIT_COMMITTER_IDENT"]);

  // Stage all non-ignored changes from the repository root, as documented for this tool.
  await runGit(repositoryRoot, ["add", "."]);
  await runGit(repositoryRoot, ["commit", "-m", input.commitMessage], { timeout: 120_000 });

  const commitIdOutput = await runGit(repositoryRoot, ["rev-parse", "--short", "HEAD"]);
  const commitId = commitIdOutput.stdout.trim();
  let finalStatus = initialStatus;
  try {
    finalStatus = await readGitStatus(repositoryRoot);
  } catch (error) {
    finalStatus = {
      ...initialStatus,
      display: `Commit succeeded, but status could not be refreshed: ${messageOf(error)}`,
    };
  }

  return {
    status: "committed",
    message: `Committed ${commitId}: ${input.commitMessage}`,
    repositoryRoot,
    branch: finalStatus.branch,
    gitStatus: finalStatus.display,
    diff: "",
    diffTruncated: false,
    commitId,
  };
}

function cleanResult(repositoryRoot: string, status: GitStatus): GitAutoCommitResult {
  return {
    status: "clean",
    message: NO_CHANGES_MESSAGE,
    repositoryRoot,
    branch: status.branch,
    gitStatus: status.display,
    diff: "",
    diffTruncated: false,
    commitId: "",
  };
}

async function readGitStatus(repositoryRoot: string): Promise<GitStatus> {
  const [branchOutput, statusOutput] = await Promise.all([
    runGit(repositoryRoot, ["branch", "--show-current"]),
    runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const branch = branchOutput.stdout.trim() || "(detached HEAD)";
  const porcelain = statusOutput.stdout;
  const display = [`## ${branch}`, porcelain.trimEnd()].filter(Boolean).join("\n");
  return { branch, porcelain, display };
}

async function createDiffPreview(
  repositoryRoot: string,
): Promise<{ diff: string; truncated: boolean }> {
  const [unstaged, staged, untrackedOutput] = await Promise.all([
    runGit(repositoryRoot, ["diff", "--no-ext-diff", "--no-color", "--"], {
      allowBufferTruncation: true,
    }),
    runGit(repositoryRoot, ["diff", "--cached", "--no-ext-diff", "--no-color", "--"], {
      allowBufferTruncation: true,
    }),
    runGit(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  let diff = "";
  let truncated = unstaged.truncated || staged.truncated;
  const append = (section: string) => {
    if (!section) return;
    if (diff.length >= MAX_DIFF_PREVIEW_CHARS) {
      truncated = true;
      return;
    }
    const remaining = MAX_DIFF_PREVIEW_CHARS - diff.length;
    if (section.length > remaining) {
      diff += section.slice(0, remaining);
      truncated = true;
    } else {
      diff += section;
    }
  };

  appendSection("Unstaged changes", unstaged.stdout, append);
  appendSection("Staged changes", staged.stdout, append);
  if (unstaged.truncated || staged.truncated) {
    append("\n[Some tracked-file diff output was cut off by the output safety limit.]\n");
  }

  const untrackedPaths = untrackedOutput.stdout.split("\0").filter(Boolean);
  let previewedUntrackedFiles = 0;
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";

  for (const relativePath of untrackedPaths) {
    if (diff.length >= MAX_DIFF_PREVIEW_CHARS) {
      truncated = true;
      break;
    }
    if (previewedUntrackedFiles >= MAX_UNTRACKED_PREVIEW_FILES) {
      append(
        "\n[Additional untracked files are listed in gitStatus but omitted from the diff preview.]\n",
      );
      truncated = true;
      break;
    }
    previewedUntrackedFiles += 1;

    const absolutePath = resolve(repositoryRoot, relativePath);
    if (!isWithin(repositoryRoot, absolutePath)) continue;

    let fileInfo;
    try {
      fileInfo = await lstat(absolutePath);
    } catch {
      append(`\n[Untracked file changed during preview: ${relativePath}]\n`);
      truncated = true;
      continue;
    }

    if (!fileInfo.isFile()) {
      append(`\n[Untracked file preview skipped for non-regular file: ${relativePath}]\n`);
      truncated = true;
      continue;
    }
    if (fileInfo.size > MAX_UNTRACKED_FILE_BYTES) {
      append(`\n[Untracked file preview skipped because it exceeds 32 KB: ${relativePath}]\n`);
      truncated = true;
      continue;
    }

    const untrackedDiff = await runGit(
      repositoryRoot,
      ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", nullDevice, relativePath],
      {
        allowDiffExitCode: true,
        allowBufferTruncation: true,
        maxBuffer: MAX_UNTRACKED_DIFF_BYTES,
      },
    );
    appendSection(`Untracked file: ${relativePath}`, untrackedDiff.stdout, append);
    truncated ||= untrackedDiff.truncated;
  }

  if (untrackedPaths.length === 0 && unstaged.stdout.length === 0 && staged.stdout.length === 0) {
    append(
      "No textual diff is available for the reported changes. Review gitStatus before committing.\n",
    );
  }

  if (truncated) {
    const marker = "\n[Diff preview truncated. Review the full changes before committing.]\n";
    diff = `${diff.slice(0, Math.max(0, MAX_DIFF_PREVIEW_CHARS - marker.length))}${marker}`;
  }

  return { diff, truncated };
}

function appendSection(title: string, content: string, append: (section: string) => void): void {
  if (!content.trim()) return;
  append(`## ${title}\n${content.trimEnd()}\n\n`);
}

async function runGit(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: options.timeout ?? 15_000,
      maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { stdout, truncated: false };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";

    if (failure.code === "ENOENT") {
      throw new Error("Git was not found. Install Git and make sure it is available on PATH.");
    }
    if (options.allowDiffExitCode && args.includes("--no-index") && String(failure.code) === "1") {
      return { stdout, truncated: false };
    }
    if (options.allowBufferTruncation && failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { stdout, truncated: true };
    }

    const stderr =
      typeof failure.stderr === "string" ? failure.stderr.trim() : String(failure.stderr ?? "");
    const detail = stderr || failure.message || String(error);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

function validateCommitMessage(message: string): void {
  if (
    message.length > MAX_COMMIT_MESSAGE_LENGTH ||
    message.trim() !== message ||
    !CONVENTIONAL_COMMIT_PATTERN.test(message)
  ) {
    throw new Error(
      "Commit message must be a single-line Conventional Commit, for example 'feat: add git auto commit tool' (maximum 100 characters).",
    );
  }
}

function hasUnmergedPaths(porcelain: string): boolean {
  return porcelain
    .split(/\r?\n/)
    .some((line) => line.slice(0, 2).includes("U") || ["AA", "DD"].includes(line.slice(0, 2)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}
