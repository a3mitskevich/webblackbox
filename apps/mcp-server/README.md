<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://raw.githubusercontent.com/a3mitskevich/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/mcp-server</h1>

<p align="center">
  MCP server for AI-assisted web session analysis.
</p>

<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-374151" alt="License" /></a>
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

Model Context Protocol (MCP) server for AI-assisted web session analysis. Exposes WebBlackbox session data and analysis tools via the [Model Context Protocol](https://modelcontextprotocol.io/), enabling AI assistants (Claude, ChatGPT, etc.) to inspect, query, and reason about recorded web sessions.

## Run From Source

This fork does not publish to npm: `npx @webblackbox/mcp-server` runs the upstream package, which has no `--allow-dir`
and cannot read format-2 archives. Build the CLI from the workspace (Node.js 22 or newer):

```bash
pnpm install
pnpm --filter @webblackbox/mcp-server build   # also builds protocol and player-sdk
node apps/mcp-server/dist/cli.js --help
```

The server starts over stdio, which is the mode expected by MCP clients.

Example MCP client entry:

```json
{
  "command": "node",
  "args": ["/path/to/webblackbox/apps/mcp-server/dist/cli.js"]
}
```

### Restricting file access

By default the tools can read archives and list directories anywhere the server process can.
Pass `--allow-dir <dir>` or `--allow-dir=<dir>` (repeatable) to limit access to specific directories. Every
filesystem path a tool receives (archive paths, `list_archives` directories, `symbolicate_stack`'s `mapsDir`) is
checked before and after symlinks are resolved, and anything outside the allowed directories is rejected:

```json
{
  "command": "node",
  "args": ["/path/to/webblackbox/apps/mcp-server/dist/cli.js", "--allow-dir", "/path/to/archives"]
}
```

## Technology Stack

- **Node.js / TypeScript**
- **@modelcontextprotocol/sdk** — MCP server framework
- **@webblackbox/player-sdk** — Archive loading and analysis

## Development

```bash
cd apps/mcp-server
pnpm dev        # tsx watch src/cli.ts
pnpm inspect    # build, then open the server in the MCP inspector
```

## Build

```bash
cd apps/mcp-server
pnpm build
```

To inspect the packaged CLI locally:

```bash
cd apps/mcp-server
node dist/cli.js --help
node dist/cli.js --version
```

## Available Tools

### Utility tools

| Tool      | Description               |
| --------- | ------------------------- |
| `health`  | Health check              |
| `now_utc` | Get current UTC timestamp |

### Session analysis tools

| Tool                         | Description                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_archives`              | Scan a directory for `.webblackbox` / `.zip` archives                                                                                                    |
| `session_summary`            | Open one archive and return totals, top event types, top errors, slow/fails, and the other tabs of the recorded site open in parallel                    |
| `query_events`               | Query events by text/type/level/request/time range with pagination                                                                                       |
| `network_issues`             | Return failed and slow network requests sorted by severity                                                                                               |
| `generate_bug_report`        | Generate markdown + GitHub/Jira issue artifacts from one archive                                                                                         |
| `export_har`                 | Export HAR JSON from an archive (optionally scoped by mono range)                                                                                        |
| `generate_playwright`        | Generate a Playwright script from captured actions (optional range/start URL/HAR replay wiring)                                                          |
| `summarize_actions`          | Summarize action spans with trigger/duration plus request, error, and screenshot context                                                                 |
| `find_root_cause_candidates` | Find likely root-cause signals around errors (nearby failed requests, warn/error console, AI hints)                                                      |
| `compare_sessions`           | Compare two archives (event/action/error/network/perf/storage deltas + endpoint-level regressions)                                                       |
| `symbolicate_stack`          | Map minified stack traces (error events, one event, or a pasted stack) to original sources using maps embedded in the archive plus an optional `mapsDir` |

## Notes

- Archive paths are resolved from the current working directory if relative.
- Archive content is untrusted: every archive tool result is preceded by a text block marking the JSON payload as data, not instructions, and the server publishes the same rule in its MCP `instructions`.
- Encrypted archives require `passphrase`. Archive formats 1 and 2 are read through `@webblackbox/player-sdk`, with its load caps for untrusted archives.
- `query_events` defaults to payload-hidden output (`includeData=false`) to avoid huge responses.
- `symbolicate_stack` reads only `.map` files under `mapsDir` (symbolic links are skipped) and never fetches URLs recorded in the archive.
- Range-scoped tools (`monoStart` / `monoEnd`) preload only intersecting chunks when opening archives.

## License

[MIT](https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE)
