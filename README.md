<p align="center">
  <img src="logo.png" alt="WebBlackbox" width="128" height="128" />
</p>

<h1 align="center">WebBlackbox</h1>

<p align="center">
  <strong>A flight recorder and time-travel debugger for web applications.</strong>
  <br />
  <sub>Press Start in the tab you are testing. When something goes wrong, you know exactly what happened — and why.</sub>
</p>

<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox/actions/workflows/ci.yml"><img src="https://github.com/a3mitskevich/webblackbox/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-374151" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/TypeScript-first-blue" alt="TypeScript" />
</p>

---

This is a fork of [webllm/webblackbox](https://github.com/webllm/webblackbox) prepared for a QA pilot. It is built from source: nothing in this fork is published to npm, the Chrome Web Store or GitHub Releases, and upstream's hosted Player cannot open the archives this fork writes (they are always encrypted, archive format 2). Run your own Player instead (see [Self-host the Player](#self-host-the-player)).

WebBlackbox records what happened inside your web app, packages it into an encrypted, portable `.webblackbox` archive, and lets you replay the session later with timeline, screenshots, tab video, network, console, storage, DOM and performance context intact.

## Choose Your Path

| Goal                                  | Use                          | Docs                                                             |
| ------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Record sessions in Chrome             | `apps/extension`             | [apps/extension/README.md](apps/extension/README.md)             |
| Replay and inspect archives           | `apps/player`, served by you | [apps/player/README.md](apps/player/README.md)                   |
| Embed lite capture in your app        | `packages/webblackbox`       | [packages/webblackbox/README.md](packages/webblackbox/README.md) |
| Build archive analysis tooling        | `packages/player-sdk`        | [packages/player-sdk/README.md](packages/player-sdk/README.md)   |
| Analyze archives with an AI assistant | `apps/mcp-server`            | [apps/mcp-server/README.md](apps/mcp-server/README.md)           |
| Self-host share links (optional)      | `apps/share-server`          | [apps/share-server/README.md](apps/share-server/README.md)       |

## Quick Start

Requirements: Node 22 or newer, pnpm 10.28.1 (`corepack enable`), Chrome.

### Build from source

```bash
pnpm install
pnpm build
```

### Record with the Chrome extension

1. Open `chrome://extensions/`, enable `Developer mode`, click `Load unpacked` and select `apps/extension/build`.
2. Open the tab you want to test and click the WebBlackbox toolbar icon. Pick a recording profile, or leave `Auto (site rules)` so your site rules choose one, check the `Lite` / `Full` engine and press `Start`. The popup then offers to reload the page: the recording starts first and the page reloads after it, so the page load is captured from scratch.
3. Reproduce the issue. `Marker` (or Ctrl/Cmd + Shift + M) flags the moment.
4. Press `Stop`, then `Export` with a passphrase of at least 8 characters. Every archive is encrypted; there is no plaintext export. The Sessions page lists, filters and bulk-exports the recordings kept in this browser.

### Open the archive in the Player

```bash
pnpm player   # builds apps/player and serves it on http://localhost:4177/
```

Open the Player, drop the `.webblackbox` file on it and enter the passphrase. To get `Export and open in Player` on the Sessions page, set the Player's address in the extension's options under `Export & encryption` → `Player URL`.

### Embed lite capture in your app

The `webblackbox` package is not published from this fork; depend on it from this workspace (`"webblackbox": "workspace:*"`) or on its build output in `packages/webblackbox/dist`.

```ts
import { WebBlackboxLiteSdk } from "webblackbox";

const sdk = new WebBlackboxLiteSdk();
await sdk.start();
```

Details: [packages/webblackbox/README.md](packages/webblackbox/README.md).

## Self-host the Player

The Player is a static single-page app (React, built with Vite into `apps/player/build/`). Serve that folder from any static host:

- **HTTPS is required** (or `localhost` for a Player on your own computer). Archives are decrypted in the browser with Web Crypto, which only works in a secure context.
- Archives stay in the browser: the Player opens a local file, and nothing is uploaded unless you use the optional share server.
- `pnpm --filter @webblackbox/player build` builds it; `pnpm player` builds and serves it locally on port 4177.

Point the extension at it: options page → `Export & encryption` → `Player URL` (an `https:` address, or `http:` on `localhost` / `127.0.0.1`). Organizations can preset it with the managed policy key `playerUrl` (see [docs/ENTERPRISE_ADMIN.md](docs/ENTERPRISE_ADMIN.md)); a policy value wins and is read-only in the options page. The extension has no built-in Player address: until one is set, `Export and open in Player` is hidden. The extension only opens the Player page; the archive stays in your downloads folder until you drop it in.

## How Recording Works

- **Only after Start.** Nothing records until you press `Start` in a tab, and the recording ends when you press `Stop`.
- **Profiles decide what is kept.** Built-in profiles: `Default` (editable; metadata only — no console text, bodies or input values), `Lite`, `Full`, `QA` (console text, JSON/text/form/XML/GraphQL bodies up to 256 KiB, screenshots, paths and titles of other tabs of the site) and `Full capture` (everything, recorded raw without content masking: console with stacks, all textual bodies up to 1 MiB, input values, storage values, the raw DOM, screenshots, optional tab video, 60 Hz pointer). You can add custom profiles and import or export them as a file.
- **Site rules pick a profile.** With `Auto (site rules)`, the highest-priority enabled rule that matches the page wins. Rules match host and path globs, query parameters, a title regex, a present selector or meta tag, and incognito.
- **Two engines.** `Lite` records page-side signals plus a browser-side network baseline, with minimal overhead. `Full` drives the Chrome DevTools Protocol for network (with bodies), navigation, runtime and screenshots. A profile that asks for something only `Full` can record (bodies, screenshots, tab video, whole console messages, CDP) locks the engine to `Full`. A recording stops if its profile changes after Start.
- **Page reload offer.** Start asks whether to reload the page (`Reload and Start` / `Start Without Reload`), in both engines: the recording starts first, then the page reloads, so its first requests, scripts and early errors are captured. The question can be turned off in the options.
- **Content script on demand.** A setting decides whether the extension's small content script runs in every page from `document_start` (the default, so pages a recorded tab loads later have it before their own code) or is injected only into the tab where a recording starts (nothing runs in pages you are not recording).
- **Encrypted at rest.** Recordings kept in the browser are encrypted with a per-browser-session key held in `chrome.storage.session`. A stopped recording that was not exported is deleted after 10 minutes by default (5 for `Full capture`; each profile sets its own time, up to 24 hours), and a successful export deletes the local copy by default. Closing the browser or reloading the extension loses the key, so nothing outlives the browser session; export what you want to keep.
- **Exports are always encrypted.** AES-GCM with a PBKDF2-derived key (600,000 iterations) from a passphrase of at least 8 characters. Archive format 2 keeps only a minimal plaintext envelope (format version and encryption parameters); the full manifest is encrypted. Archives in the older format 1 still open.
- **Masking is a tool, not a guarantee.** Each profile's redaction rules (blocked and unmasked selectors, header and body masking, URL stripping) hide what you choose, on a best-effort basis. The passphrase and the encryption are what protect a recording. A privacy scanner reports findings after an export without blocking it. See [Privacy Model](docs/PRIVACY.md).

## What This Fork Adds

- **Full-capture completeness.** In `Full`, every body the profile asks for is either in the archive or recorded as missing with a reason (`network.body.skipped`: MIME not allowed, filtered, too large, …), and the Player shows a completeness report for the archive.
- **Source-mapped stacks.** Script source map references (optionally the maps themselves) are recorded, so minified stack traces are symbolicated in the Player, the Player SDK and the MCP tools.
- **Pointer capture.** Clicks, pointer down/up, context and auxiliary clicks, drag, wheel, hover and selection with readable targets; rage and dead clicks; click ripples in the Player.
- **Other tabs of the site.** A snapshot of the recorded site's other tabs at start and their changes during the recording (opened, navigated, activated, closed, …), shown in the Player, the MCP tools and the bug report.
- **Recording profiles and site rules**, with fine-grained sensitivity per category and export safeguards (see above).
- **Russian locale.** The extension and the Player speak English, Russian and Simplified Chinese, with locale-aware formatting.
- **The Player, rewritten in React.** Activity feed, network panel (headers, bodies with highlighting, WebSocket conversation view), console, storage, performance, session compare, event inspector, other tabs, code generators (curl, fetch, HAR, Playwright, bug report), command palette, keyboard shortcuts, download of the recorded tab video as a plain file, live language switch, light and dark themes, strict CSP.
- **MCP server hardening.** Archive content is marked as untrusted in tool results, and `--allow-dir` limits the directories the server may read archives from.
- **Share server trust boundaries.** Forwarded headers are read only from configured trusted proxies, keyless loopback access is decided from the socket peer, a `Host` allowlist guards against DNS rebinding (always in keyless mode, opt-in with API keys), the Player confirms `?share=` links to unknown origins, and audit events are written before the response is sent.
- **Hardening across the stack.** Typed keys in editable fields (apart from service keys and shortcuts) are kept only when the profile's `inputs` level is `allow`, and keys typed into password fields only when content masking is off (as in `Full capture`), body values and base64 bodies are masked, the recorder allowlists CDP Network fields, the Player SDK caps and validates untrusted archives on load, and generated replay code quotes archive values.

## What It Captures

The protocol defines 76 event types in 12 categories (`WEBBLACKBOX_EVENT_TYPES` in [packages/protocol/src/constants.ts](packages/protocol/src/constants.ts)):

| Category  | Types | Examples                                                                                 |
| --------- | ----: | ---------------------------------------------------------------------------------------- |
| `meta`    |     5 | session start/end, config, snapshot and changes of other tabs                            |
| `privacy` |     1 | privacy violation                                                                        |
| `sys`     |     4 | debugger attach/detach, notices, script source map references                            |
| `nav`     |     5 | commit, history push/replace, hash change, reload                                        |
| `user`    |    22 | clicks, keys, input, submit, scroll, pointer, drag, wheel, hover, focus, markers         |
| `console` |     1 | console entries                                                                          |
| `error`   |     4 | exceptions, unhandled rejections, resource errors, assertions                            |
| `network` |    11 | request, response, finished, failed, redirect, bodies, skipped bodies, WebSocket and SSE |
| `dom`     |     4 | mutation batches, snapshots, diffs, rrweb-compatible events                              |
| `screen`  |     6 | screenshots, tab video recording, viewport                                               |
| `storage` |     8 | cookies, localStorage, sessionStorage, IndexedDB, Cache, service worker lifecycle        |
| `perf`    |     5 | Web Vitals, long tasks, traces, CPU profiles, heap snapshots                             |

How much of each category is kept depends on the recording profile and the engine. For the full event schema, defaults and message types, see [packages/protocol/README.md](packages/protocol/README.md).

## Archive Format

A `.webblackbox` file is a ZIP archive (format 2) containing:

- `manifest.json`: the plaintext envelope, only the format version and the encryption parameters
- `meta/manifest.json`: the export metadata (encrypted)
- `privacy/manifest.json`: the effective capture policy, per-category summaries and privacy scanner results (encrypted)
- chunked NDJSON event streams
- time, request and text indexes
- content-addressed blobs for screenshots, tab video, DOM snapshots, captured bodies and source maps
- integrity hashes for verification

The contents of every file except the envelope and the integrity hashes are encrypted with AES-GCM under a PBKDF2-derived key; file names (chunk ids, blob hashes with their type extension) stay readable in the ZIP directory. The Player, the Player SDK and the MCP server read both format 2 and the older format 1.

## Documentation

- [Chrome Extension Guide](apps/extension/README.md)
- [Player Guide](apps/player/README.md)
- [Web SDK Guide](packages/webblackbox/README.md)
- [Player SDK Guide](packages/player-sdk/README.md)
- [MCP Server Guide](apps/mcp-server/README.md)
- [Share Server Guide](apps/share-server/README.md)
- [Privacy Model](docs/PRIVACY.md)
- [Security Overview](docs/SECURITY.md)
- [Enterprise Admin Guide](docs/ENTERPRISE_ADMIN.md)
- [Architecture Notes](docs/ARCHITECTURE.md)
- [Performance Notes](docs/PERFORMANCE.md)
- [Chrome Web Store Disclosure Source](docs/CHROME_WEB_STORE_DISCLOSURE.md) (inherited from upstream)

## Contributing

To work on the monorepo itself, start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Web LLM. The fork's changes are under the same license.
