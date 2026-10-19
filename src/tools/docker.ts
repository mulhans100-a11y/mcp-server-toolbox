import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type DockerContainerRow = Record<string, unknown>;

export async function inspectDockerContainers(includeStopped: boolean) {
  const args = ["ps", "--format", "json"];
  if (includeStopped) args.splice(1, 0, "--all");

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    }));
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & { stderr?: string };
    if (typedError.code === "ENOENT") {
      throw new Error(
        "Docker CLI was not found. Install Docker Desktop or add the Docker CLI to PATH.",
      );
    }
    const detail = typedError.stderr?.trim() || typedError.message || String(error);
    throw new Error(`Docker could not list containers: ${detail}`);
  }

  let rows: DockerContainerRow[];
  try {
    rows = stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("each output line must be a JSON object");
        }
        return parsed as DockerContainerRow;
      });
  } catch (error) {
    throw new Error(
      `Docker returned output that could not be parsed as JSON. Update the Docker CLI and confirm it supports 'docker ps --format json'. ${messageOf(error)}`,
    );
  }

  const containers = rows.map((container) => ({
    id: stringField(container, "ID"),
    name: stringField(container, "Names"),
    image: stringField(container, "Image"),
    state: stringField(container, "State"),
    status: stringField(container, "Status"),
    ports: stringField(container, "Ports"),
    createdAt: stringField(container, "CreatedAt"),
  }));

  return {
    count: containers.length,
    includeStopped,
    containers,
  };
}

function stringField(row: DockerContainerRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
