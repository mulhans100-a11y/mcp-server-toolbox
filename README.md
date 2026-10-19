# Local Developer Toolbox MCP

![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-typed%20MCP%20server-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

A small, local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI
coding assistants a few practical developer tools: search local logs, inspect Docker containers, and
clean up JSON payloads.

The server communicates over **stdio**, so Claude Desktop, Cursor, and other MCP clients launch it
as a local process. The server itself makes no network requests or file writes. The Docker CLI
follows the currently selected Docker context.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install and build](#install-and-build)
- [Configure log access](#configure-log-access)
- [Connect to Claude Desktop](#connect-to-claude-desktop)
- [Connect to Cursor](#connect-to-cursor)
- [Tool examples](#tool-examples)
- [Security and privacy](#security-and-privacy)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Features

| Tool                       | What it does                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_local_logs`        | Searches specified log files or directories using a JavaScript regular expression. Results include file names, line numbers, and matching snippets. |
| `inspect_docker_container` | Lists local Docker containers and their state, status, image, ports, and creation time. Stopped containers are optional.                            |
| `format_json_payload`      | Pretty-prints JSON, including JSON in Markdown fences or surrounded by prose. It removes trailing commas and reports what it cleaned up.            |

Each tool publishes an input schema, an output schema, and read-only metadata. Tool responses
include structured JSON for clients that support it, plus a readable text representation.

## Requirements

- Node.js 20 or later
- Docker Desktop or Docker Engine for `inspect_docker_container` (optional for the other tools)

## Install and build

```bash
git clone https://github.com/YOUR-USERNAME/local-developer-toolbox-mcp.git
cd local-developer-toolbox-mcp
npm ci
npm run build
```

Start the MCP server directly with:

```bash
npm start
```

The server waits for an MCP client on stdin. Its protocol messages use stdout, so startup and
diagnostic messages are written to stderr.

For local development, `npm run dev` runs the TypeScript source with automatic restarts. To inspect
the tools without configuring a client, run:

```bash
npx -y @modelcontextprotocol/inspector node ./dist/index.js
```

## Configure log access

Log searches are restricted to `TOOLBOX_LOG_DIRS`. Set it to one or more absolute directories,
separated with the operating system's path separator (`;` on Windows, `:` on macOS and Linux). If it
is unset, the server's current working directory is the only allowed root.

Example values:

```text
Windows: C:\Users\you\my-app\logs;D:\service\logs
macOS/Linux: /Users/you/my-app/logs:/var/log/my-service
```

When a directory is passed to `search_local_logs`, it recursively searches `.log`, `.log.*`, `.txt`,
`.out`, `.err`, and `.jsonl` files. An explicitly named file can have any extension. Relative paths
are resolved under an allowed root. Directory traversal skips common build/dependency folders and
does not follow symbolic links. Paths outside the configured roots are rejected, including paths
that resolve outside a root through a symbolic link.

The tool streams files line by line and returns at most 200 matches. Lines longer than 1,000,000
characters are skipped to bound memory use, and the result reports their count in
`skippedOversizedLines`. Long matching lines are shortened in the response. Directory scans stop
after 500 unique log files or 2,000 directories and report `truncated: true` when a limit is hit.
The `pattern` argument is a JavaScript regular expression and is case-insensitive by default; set
`caseSensitive` to `true` for a case-sensitive search. Patterns flagged by a heuristic as
potentially vulnerable to excessive backtracking are rejected; complex safe patterns may also be
rejected.

## Connect to Claude Desktop

Build the project first. Then add a `local-developer-toolbox` entry to Claude Desktop's `mcpServers`
configuration. Use absolute paths for both Node.js and `dist/index.js`; this avoids relying on the
app's `PATH`.

The configuration file is typically:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux builds:** `~/.config/Claude/claude_desktop_config.json`

Example for Windows (replace the paths with your own):

```json
{
  "mcpServers": {
    "local-developer-toolbox": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\local-developer-toolbox-mcp\\dist\\index.js"],
      "env": {
        "TOOLBOX_LOG_DIRS": "C:\\path\\to\\your\\application\\logs"
      }
    }
  }
}
```

Example for macOS (replace the paths with your own):

```json
{
  "mcpServers": {
    "local-developer-toolbox": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/local-developer-toolbox-mcp/dist/index.js"],
      "env": {
        "TOOLBOX_LOG_DIRS": "/absolute/path/to/application/logs"
      }
    }
  }
}
```

If the file already contains other servers, add this entry inside the existing `mcpServers` object
rather than replacing the file. Save the file and fully restart Claude Desktop. Open **Settings →
Developer** to check whether the server started and its tools are available. On some packaged
Windows installations, the app may use a package-local configuration path; if the standard
`%APPDATA%` file is ignored, check the MCP connection status and logs in Claude Desktop's Developer
settings. See
[Claude's local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
for current extension-based setup. This repository currently provides the stdio server and manual
configuration shown above.

## Connect to Cursor

Cursor supports project-level `.cursor/mcp.json` and global `~/.cursor/mcp.json` configuration. Use
the project-level file when the server is specific to one repository, or the global file to make it
available across projects. Build the server first, then add:

```json
{
  "mcpServers": {
    "local-developer-toolbox": {
      "command": "node",
      "args": ["/absolute/path/to/local-developer-toolbox-mcp/dist/index.js"],
      "env": {
        "TOOLBOX_LOG_DIRS": "/absolute/path/to/application/logs"
      }
    }
  }
}
```

On Windows, use absolute Windows paths and escape backslashes in JSON. For example, set `command` to
`C:\\Program Files\\nodejs\\node.exe`, and use paths such as
`C:\\path\\to\\local-developer-toolbox-mcp\\dist\\index.js` in `args`. Restart or reload Cursor
after saving the config, then enable the server from its MCP tools list if needed.

For the latest configuration options and file locations, see
[Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol).

### Windows configuration example

```json
{
  "mcpServers": {
    "local-developer-toolbox": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\local-developer-toolbox-mcp\\dist\\index.js"],
      "env": {
        "TOOLBOX_LOG_DIRS": "C:\\path\\to\\your\\application\\logs"
      }
    }
  }
}
```

## Tool examples

### `search_local_logs`

```json
{
  "paths": ["./logs", "C:/work/api/logs/app.log"],
  "pattern": "(ERROR|FATAL)\\s+.*timeout",
  "caseSensitive": false,
  "maxResults": 50
}
```

When searching a directory, only recognized log extensions are included. When searching an
explicitly named file, the path is read directly if it is within an allowed root.

### `inspect_docker_container`

```json
{
  "includeStopped": false
}
```

This runs `docker ps` (or `docker ps --all` when stopped containers are requested). It is read-only.
Docker must be installed, available on `PATH`, and connected to a running daemon.

### `format_json_payload`

```json
{
  "payload": "Here is the response: {\"ok\":true,\"items\":[1,2,],}",
  "indent": 2
}
```

The result includes `formattedJson`, `extractedFromSurroundingText`, and `removedTrailingCommas`.
The formatter does not guess missing braces, convert single quotes, or invent values; malformed JSON
that cannot be safely cleaned returns an error.

## Security and privacy

- This is a local stdio server. Its tools do not write files or make application-level network
  requests. The Docker CLI follows the active Docker context, which may point to a remote engine.
- Log access is limited to configured roots. Keep those roots as narrow as practical; matching log
  lines are returned to the connected AI client and may contain sensitive data.
- The Docker tool invokes only the read-only `docker ps` command. It does not run arbitrary shell
  commands or inspect container filesystems.
- Review tool calls and outputs according to your AI client's normal approval controls.

## Reporting a vulnerability

Please report security issues through GitHub's private **Report a vulnerability** option on the
repository's **Security** tab. See [SECURITY.md](SECURITY.md) for details.

## Troubleshooting

### The server does not appear in the client

- Confirm `npm run build` completed and that the config points to the built `dist/index.js` file.
- Use absolute paths to both Node.js and the server entry point, then fully restart the client.
- In Claude Desktop, check **Settings → Developer** for server status and MCP logs. Some packaged
  Windows installations use an app-managed config location.
- In Cursor, reload the window and check the MCP tools list for a startup error.

### Log search returns no files

- Confirm `TOOLBOX_LOG_DIRS` points to an existing directory and that the requested path resolves
  inside one of its roots.
- Directory searches only include recognized log extensions. Pass a specific file path if it uses
  another extension.
- The server starts with the client's working directory as the allowed root when `TOOLBOX_LOG_DIRS`
  is unset.

### Docker inspection fails

- Check that Docker is installed and the daemon is running.
- Run `docker ps` in a terminal launched under the same user account.
- The tool respects the active Docker context, including a remote context if one is selected.

## Development

```bash
npm run format
npm run check
```

The implementation uses the official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and Zod schemas for
tool input validation.

## License

MIT. See [LICENSE](LICENSE).
