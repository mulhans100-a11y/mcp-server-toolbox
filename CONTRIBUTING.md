# Contributing

Thanks for helping improve Local Developer Toolbox MCP. Keep changes focused, document user-visible
behavior in the README, and preserve the server's local, read-only tool boundaries.

## Development setup

1. Install Node.js 20 or later.
2. Clone the repository and run `npm ci`.
3. Make your changes in `src/` and update the relevant documentation.

## Before opening a pull request

Run the formatter and project checks:

```bash
npm run format
npm run check
```

`npm run check` checks formatting, TypeScript types, and the production build.

## Tool design

- Keep tools read-only and limit access to the requested local data.
- Validate input with a Zod schema and set practical size or result limits.
- Send diagnostics to stderr; stdout is reserved for MCP protocol messages.
- Include examples and any new configuration options in the README.

## Reporting an issue

Include your operating system, Node.js version, MCP client, the affected tool, and the relevant
error message. Remove secrets and personal data from logs before sharing them.
