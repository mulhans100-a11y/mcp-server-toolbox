import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import safeRegex from "safe-regex2";

const MAX_FILES = 500;
const MAX_DIRECTORIES = 2_000;
const MAX_LOG_LINE_LENGTH = 1_000_000;
const MAX_SNIPPET_LENGTH = 1_200;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".next", "dist", "build"]);
const DIRECTORY_LOG_FILE = /\.(?:log(?:\..*)?|txt|out|err|jsonl)$/i;

export interface SearchLocalLogsInput {
  paths: string[];
  pattern: string;
  caseSensitive: boolean;
  maxResults: number;
}

interface LogMatch {
  file: string;
  line: number;
  text: string;
  truncatedLine: boolean;
}

interface WalkResult {
  fileLimitReached: boolean;
  directoryLimitReached: boolean;
}

interface WalkState {
  files: Set<string>;
  warnings: string[];
  visitedDirectories: Set<string>;
  directoriesVisited: number;
}

interface LogLine {
  text: string;
  oversized: boolean;
}

export async function searchLocalLogs(input: SearchLocalLogsInput) {
  let matcher: RegExp;
  try {
    matcher = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression: ${detail}`);
  }
  if (!safeRegex(matcher)) {
    throw new Error(
      "This regular expression may cause excessive backtracking and is not supported.",
    );
  }

  const allowedRoots = await getAllowedRoots();
  const files = new Set<string>();
  const warnings: string[] = [];
  const walkState: WalkState = {
    files,
    warnings,
    visitedDirectories: new Set<string>(),
    directoriesVisited: 0,
  };
  let fileLimitReached = false;
  let directoryLimitReached = false;

  for (const requestedPath of input.paths) {
    try {
      const target = await resolveAllowedPath(requestedPath, allowedRoots);
      const targetStats = await stat(target);

      if (targetStats.isFile()) {
        if (!files.has(target)) {
          if (files.size >= MAX_FILES) {
            fileLimitReached = true;
            break;
          }
          files.add(target);
        }
      } else if (targetStats.isDirectory()) {
        const walkResult = await collectLogFiles(target, walkState);
        fileLimitReached ||= walkResult.fileLimitReached;
        directoryLimitReached ||= walkResult.directoryLimitReached;
        if (fileLimitReached || directoryLimitReached) break;
      } else {
        warnings.push(`Skipped non-file path: ${requestedPath}`);
      }
    } catch (error) {
      warnings.push(`${requestedPath}: ${messageOf(error)}`);
    }
  }

  const uniqueFiles = [...files];
  const matches: LogMatch[] = [];
  let scannedFiles = 0;
  let truncated = fileLimitReached || directoryLimitReached;
  let skippedOversizedLines = 0;
  let stopSearching = false;

  for (const file of uniqueFiles) {
    if (stopSearching) break;
    scannedFiles += 1;

    try {
      let lineNumber = 0;

      for await (const lineResult of readLogLines(file)) {
        lineNumber += 1;
        if (lineResult.oversized) {
          skippedOversizedLines += 1;
          continue;
        }
        const line = lineResult.text;
        if (!matcher.test(line)) continue;

        if (matches.length >= input.maxResults) {
          truncated = true;
          stopSearching = true;
          break;
        }

        const text = line.slice(0, MAX_SNIPPET_LENGTH);
        matches.push({
          file,
          line: lineNumber,
          text: text.length < line.length ? `${text}…` : text,
          truncatedLine: text.length < line.length,
        });
      }
    } catch (error) {
      warnings.push(`${file}: ${messageOf(error)}`);
    }
  }

  return {
    pattern: input.pattern,
    scannedFiles,
    returnedMatchCount: matches.length,
    skippedOversizedLines,
    truncated,
    matches,
    warnings: warnings.slice(0, 25),
  };
}

async function getAllowedRoots(): Promise<string[]> {
  const configured = process.env.TOOLBOX_LOG_DIRS?.split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = configured && configured.length > 0 ? configured : [process.cwd()];
  const roots: string[] = [];

  for (const candidate of candidates) {
    const root = await realpath(resolve(candidate));
    if (!(await stat(root)).isDirectory()) {
      throw new Error(`Configured log root is not a directory: ${candidate}`);
    }
    roots.push(root);
  }

  if (roots.length === 0) {
    throw new Error("No readable log roots are configured.");
  }
  return roots;
}

async function resolveAllowedPath(requestedPath: string, roots: string[]): Promise<string> {
  const candidates = isAbsolute(requestedPath)
    ? [resolve(requestedPath)]
    : [resolve(requestedPath), ...roots.map((root) => resolve(root, requestedPath))];
  let missingPathError: unknown;
  let hadAllowedCandidate = false;

  for (const candidate of new Set(candidates)) {
    if (!roots.some((root) => isWithin(root, candidate))) continue;
    hadAllowedCandidate = true;
    try {
      const resolvedCandidate = await realpath(candidate);
      if (roots.some((root) => isWithin(root, resolvedCandidate))) return resolvedCandidate;
    } catch (error) {
      missingPathError = error;
    }
  }

  if (hadAllowedCandidate && missingPathError) throw missingPathError;
  throw new Error("Path is outside the configured log directories.");
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

async function collectLogFiles(directory: string, state: WalkState): Promise<WalkResult> {
  if (state.visitedDirectories.has(directory)) {
    return { fileLimitReached: false, directoryLimitReached: false };
  }
  state.visitedDirectories.add(directory);
  state.directoriesVisited += 1;
  if (state.directoriesVisited > MAX_DIRECTORIES) {
    return { fileLimitReached: false, directoryLimitReached: true };
  }

  const entries = await opendir(directory);
  for await (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      try {
        const nested = await collectLogFiles(entryPath, state);
        if (nested.fileLimitReached || nested.directoryLimitReached) return nested;
      } catch (error) {
        state.warnings.push(`${entryPath}: ${messageOf(error)}`);
      }
    } else if (entry.isFile() && DIRECTORY_LOG_FILE.test(entry.name)) {
      if (state.files.has(entryPath)) continue;
      if (state.files.size >= MAX_FILES) {
        return { fileLimitReached: true, directoryLimitReached: false };
      }
      state.files.add(entryPath);
    }
    // Symbolic links are intentionally not followed while walking directories.
  }

  return { fileLimitReached: false, directoryLimitReached: false };
}

async function* readLogLines(file: string): AsyncGenerator<LogLine> {
  const stream = createReadStream(file, { encoding: "utf8" });
  let parts: string[] = [];
  let bufferedLength = 0;
  let oversized = false;
  let pendingCarriageReturn = false;

  const append = (part: string) => {
    if (oversized || part.length === 0) return;
    if (bufferedLength + part.length > MAX_LOG_LINE_LENGTH) {
      oversized = true;
      parts = [];
      bufferedLength = 0;
      return;
    }
    parts.push(part);
    bufferedLength += part.length;
  };

  const takeLine = (): LogLine => {
    const line = { text: oversized ? "" : parts.join(""), oversized };
    parts = [];
    bufferedLength = 0;
    oversized = false;
    return line;
  };

  try {
    for await (const chunkValue of stream) {
      const chunk = String(chunkValue);
      let cursor = 0;

      if (pendingCarriageReturn) {
        yield takeLine();
        pendingCarriageReturn = false;
        if (chunk.startsWith("\n")) cursor = 1;
      }

      while (cursor < chunk.length) {
        const newline = chunk.indexOf("\n", cursor);
        const carriageReturn = chunk.indexOf("\r", cursor);
        const delimiterIndex =
          newline === -1
            ? carriageReturn
            : carriageReturn === -1
              ? newline
              : Math.min(newline, carriageReturn);

        if (delimiterIndex === -1) {
          append(chunk.slice(cursor));
          break;
        }

        append(chunk.slice(cursor, delimiterIndex));
        if (chunk[delimiterIndex] === "\r" && delimiterIndex === chunk.length - 1) {
          pendingCarriageReturn = true;
          break;
        }

        yield takeLine();
        cursor = delimiterIndex + 1;
        if (chunk[delimiterIndex] === "\r" && chunk[cursor] === "\n") cursor += 1;
      }
    }

    if (pendingCarriageReturn) yield takeLine();
    else if (oversized || bufferedLength > 0) yield takeLine();
  } finally {
    stream.destroy();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
