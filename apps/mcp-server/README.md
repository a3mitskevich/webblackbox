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

| Tool                         | Description                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_archives`              | Scan a directory for `.webblackbox` / `.zip` archives                                                                                                                           |
| `session_summary`            | Open one archive and return totals, top event types, top errors, slow/fails, and the other tabs of the recorded site open in parallel                                           |
| `query_events`               | Query events by text/type/level/request/time range with pagination                                                                                                              |
| `network_issues`             | Return failed and slow network requests sorted by severity                                                                                                                      |
| `generate_bug_report`        | Generate markdown + GitHub/Jira issue artifacts from one archive                                                                                                                |
| `export_har`                 | Export HAR JSON from an archive (optionally scoped by mono range)                                                                                                               |
| `generate_playwright`        | Generate a Playwright script from captured actions (optional range/start URL/HAR replay wiring)                                                                                 |
| `summarize_actions`          | Summarize action spans with trigger/duration plus request, error, and screenshot context                                                                                        |
| `find_root_cause_candidates` | Find likely root-cause signals around errors (nearby failed requests, warn/error console, AI hints)                                                                             |
| `compare_sessions`           | Compare two archives (event/action/error/network/perf/storage deltas + endpoint-level regressions)                                                                              |
| `symbolicate_stack`          | Map minified stack traces (error events, one event, or a pasted stack) to original sources using maps embedded in the archive plus an optional `mapsDir`                        |
| `page_state_at`              | What the user saw and could do at a moment (`eventId`, `actionId`, `mono` or `t`): the accessibility snapshot linked to it and the nearest ones before/after, within `maxChars` |
| `find_on_page`               | When a text (in accessible names and values) and/or a role (alert, dialog, button…) appeared on screen and when it disappeared                                                  |

### Drill-down tools

The agent works from summary to detail. `session_summary` says what went wrong; `timeline` shows a time window as
compact rows; `action_detail`, `request_detail` and `frame_at` open one item in full. Every row and result carries
the ids the next tool takes (`eventId`, `requestId`, `actionId`), and times are `mono` milliseconds throughout.

| Tool             | Description                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeline`       | Chronological rows for a window (`monoStart`/`monoEnd`, or `aroundEventId`/`aroundMono` ± `windowMs`): actions, network (one row per request), console, errors, navigation, storage, DOM, screenshots, sockets. `kinds` filter, `countsByKind` |
| `action_detail`  | One user action: trigger, the full target as recorded (tag, id, classes, role, text, test id, rect, frame, selector candidates, raw JSON), modifiers, DOM reaction, and the requests / errors / console / DOM changes / navigations it caused  |
| `request_detail` | One request: status, timing phases, headers, decoded request and response bodies (JSON pretty-printed), initiator, redirects, linked action, and WebSocket/SSE messages (paged)                                                                |
| `frame_at`       | What the page looked like at `mono` / `eventId` / `actionId` (+ `offsetMs`): the nearest screenshot, or the tab video frame, as an MCP image block with its exact time, distance and the neighbouring screenshots                              |

**Linking requests to actions.** The recorder links events to an action (`ref.act`) by arrival order, which in Full
mode can miss a click's own request or give it to the neighbouring action. `action_detail` therefore lists both
`link: "ref"` items (linked by the recorder) and `link: "time"` items (started after the trigger and before the next
action, at most 1.5 s, with the `recordedActionId` the recorder gave them), and `request_detail` returns
`actionByTime` next to `linkedAction`.

**Size budgets.** Results are small by default and always say when they left something out:

- `timeline` pages with `limit` (default 50) and a `maxBytes` budget (default 32 KB); `truncated` and `nextCursor`
  continue. Pointer noise (moves, hovers, scrolls) is hidden unless `kinds` includes `pointer`.
- `action_detail` caps every linked list at `limit` (default 10) and then halves the largest lists until the result
  fits `maxBytes` (default 24 KB); each list keeps its `total`, and `truncatedLists` names what was cut. If that is
  not enough, the raw target JSON is left out; `withinBudget` says whether the result fits.
- `request_detail` returns `maxBodyBytes` of each body (default 16 KB) with `"N of M bytes"`; header values stop at
  2 KB and URLs at 4 KB; socket messages page with `frameLimit` / `frameCursor`, `maxFrameBytes` each, and a page
  stops at 256 KB of messages. `capturedPrefixOnly` marks a body the recorder itself cut at the profile limit, and
  `missingReason` says why a body is absent.
- `frame_at` returns at most `maxBytes` of image (default 1 MB). `includeImage: false` returns only the metadata.

**Images and video frames.** Node has no WebCodecs and an image library would be a heavy native dependency, so
`frame_at` uses an `ffmpeg` binary when one is available and never requires it:

- Without ffmpeg: the nearest screenshot, as recorded (`maxWidth` is then ignored, with a note). One over
  `maxBytes` is withheld with the reason. The same applies when ffmpeg fails on an image.
- With ffmpeg (on `PATH`, or `WEBBLACKBOX_MCP_FFMPEG=/path/to/ffmpeg`): `source: "auto"` takes a screenshot within
  250 ms, otherwise decodes the tab video at that time (JPEG, `maxWidth` default 1280 px); oversized or
  `maxWidth`-capped screenshots are re-encoded smaller. Video times map session time onto the segment start, so
  expect a frame or two of skew.
- `WEBBLACKBOX_MCP_FFMPEG=off` disables decoding. ffmpeg runs with a forced demuxer, the `file` protocol only and a
  30 s timeout, on a temp copy that is deleted afterwards.

New tools register through one list: a module under `src/tools/` defines the tool with `defineArchiveTool` (its own
arguments only; `path`, `passphrase`, the `--allow-dir` check and the untrusted-data framing come from the registry)
and adds one entry to `ARCHIVE_TOOLS` in `src/tools/index.ts`.

## Notes

- Archive paths are resolved from the current working directory if relative.
- Archive content is untrusted: every archive tool result is preceded by a text block marking the JSON payload as data, not instructions, each image by its own notice, and the server publishes the same rule (and the drill-down workflow) in its MCP `instructions`.
- Encrypted archives require `passphrase`. Archive formats 1 and 2 are read through `@webblackbox/player-sdk`, with its load caps for untrusted archives.
- `query_events` defaults to payload-hidden output (`includeData=false`) to avoid huge responses.
- `symbolicate_stack` reads only `.map` files under `mapsDir` (symbolic links are skipped) and never fetches URLs recorded in the archive.
- Range-scoped tools (`monoStart` / `monoEnd`) preload only intersecting chunks when opening archives.
- `page_state_at` and `find_on_page` read the archive's accessibility snapshots, which cover the viewport: a node missing from a snapshot may only be scrolled out of view.

## License

[MIT](https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE)
