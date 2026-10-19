import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { inspectDockerContainers } from "./tools/docker.js";
import { formatJsonPayload } from "./tools/format-json.js";
import { searchLocalLogs } from "./tools/search-logs.js";

const logSearchOutputSchema = z.object({
  pattern: z.string(),
  scannedFiles: z.number().int(),
  returnedMatchCount: z.number().int(),
  skippedOversizedLines: z
    .number()
    .int()
    .describe("Number of lines skipped because they exceeded the safe processing limit."),
  truncated: z
    .boolean()
    .describe("Whether a result limit stopped the search before all possible results were read."),
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number().int(),
      text: z.string(),
      truncatedLine: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
});

const dockerOutputSchema = z.object({
  count: z.number().int(),
  includeStopped: z.boolean(),
  containers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      image: z.string(),
      state: z.string(),
      status: z.string(),
      ports: z.string(),
      createdAt: z.string(),
    }),
  ),
});

const formatJsonOutputSchema = z.object({
  formattedJson: z.string(),
  extractedFromSurroundingText: z.boolean(),
  removedTrailingCommas: z.boolean(),
});

function createServer(): McpServer {
  const server = new McpServer({
    name: "local-developer-toolbox",
    version: "0.1.0",
  });

  server.registerTool(
    "search_local_logs",
    {
      title: "Search local logs",
      description:
        "Search local log files for a regular-expression pattern. Searches only within TOOLBOX_LOG_DIRS, or the server's current working directory when that variable is unset. Very long lines are skipped, and truncated indicates when a safety or result limit stopped the search.",
      outputSchema: logSearchOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe(
            "Files or directories to search, using absolute paths or paths relative to an allowed log root.",
          ),
        pattern: z
          .string()
          .min(1)
          .max(500)
          .default("error|fatal|exception|panic")
          .describe(
            "JavaScript regular expression applied to each line; risky patterns are rejected.",
          ),
        caseSensitive: z
          .boolean()
          .default(false)
          .describe("Whether the regular expression is case-sensitive."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(100)
          .describe("Maximum number of matching lines to return."),
      }),
    },
    async (input) => {
      try {
        const result = await searchLocalLogs(input);
        return jsonResult(result);
      } catch (error) {
        return {
          content: [{ type: "text", text: `search_local_logs failed: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "inspect_docker_container",
    {
      title: "Inspect Docker containers",
      description:
        "List local Docker containers and their current status. Running containers are shown by default.",
      outputSchema: dockerOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        includeStopped: z
          .boolean()
          .default(false)
          .describe("Include stopped containers as well as running containers."),
      }),
    },
    async ({ includeStopped }) => {
      try {
        const result = await inspectDockerContainers(includeStopped);
        return jsonResult(result);
      } catch (error) {
        return {
          content: [
            { type: "text", text: `inspect_docker_container failed: ${errorMessage(error)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "format_json_payload",
    {
      title: "Format JSON payload",
      description:
        "Clean up and pretty-print a JSON object or array. Accepts a JSON code fence or surrounding prose and removes trailing commas, while preserving JSON values and reporting cleanup details.",
      outputSchema: formatJsonOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        payload: z
          .string()
          .max(1_000_000)
          .describe("JSON text, optionally inside a Markdown code fence or surrounded by prose."),
        indent: z
          .number()
          .int()
          .min(0)
          .max(8)
          .default(2)
          .describe("Number of spaces for indentation; use 0 for compact JSON."),
      }),
    },
    async ({ payload, indent }) => {
      try {
        const result = formatJsonPayload(payload, indent);
        return jsonResult(result);
      } catch (error) {
        return {
          content: [{ type: "text", text: `format_json_payload failed: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

function jsonResult<T extends object>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { ...value },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// MCP uses stdout for JSON-RPC. Keep startup and diagnostic messages on stderr.
void serveStdio(createServer);
console.error("Local Developer Toolbox MCP server started over stdio.");
