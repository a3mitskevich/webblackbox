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
  <a href="https://github.com/webllm/webblackbox/actions/workflows/ci.yml"><img src="https://github.com/webllm/webblackbox/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/webblackbox"><img src="https://img.shields.io/npm/v/webblackbox.svg?color=f97316" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/webblackbox?color=374151" alt="License" /></a>
  <a href="https://chromewebstore.google.com/detail/webblackbox/heklgedghicnjglakenbmfilolcgknnp?hl=en"><img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Extension" /></a>
  <a href="https://webllm.github.io/webblackbox/"><img src="https://img.shields.io/badge/Hosted-Player-f97316" alt="Hosted Player" /></a>
  <img src="https://img.shields.io/badge/TypeScript-first-blue" alt="TypeScript" />
</p>

---

WebBlackbox records what happened inside your web app, packages it into a portable `.webblackbox` archive, and lets you replay the session later with timeline, screenshots, network, console, storage, DOM, and performance context intact.

If you already have an archive, open it in the hosted Player:

https://webllm.github.io/webblackbox/

**Demo**:

https://github.com/user-attachments/assets/46273fc0-36f2-4aeb-9dfa-9c60cfcba98c

## Why WebBlackbox

- Record user interactions, navigation, console output, runtime errors, network traffic, storage activity, screenshots, and performance signals in one archive.
- Choose between `lite` capture for lower page-thread overhead and `full` capture for CDP-backed debugging detail.
- Record only the tabs where you press Start. A setting decides whether the extension's small content script loads in every page (so pages a recorded tab loads later have it before their own code) or only once a recording starts (nothing runs in pages you are not recording); see [Page injection](apps/extension/README.md#page-injection).
- Export encrypted, portable `.webblackbox` archives for offline replay and team handoff.
- Replay sessions with a rich Player UI and generate curl, fetch, HAR, Playwright, and bug-report artifacts.
- Connect archives to AI workflows through the MCP server.

## Choose Your Path

| Goal                                  | Use                         | Docs                                                             |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| Capture sessions in Chrome            | `@webblackbox/extension`    | [apps/extension/README.md](apps/extension/README.md)             |
| Replay and inspect archives           | Hosted Player               | https://webllm.github.io/webblackbox/                            |
| Embed lite capture in your app        | `webblackbox`               | [packages/webblackbox/README.md](packages/webblackbox/README.md) |
| Build archive analysis tooling        | `@webblackbox/player-sdk`   | [packages/player-sdk/README.md](packages/player-sdk/README.md)   |
| Analyze archives with an AI assistant | `@webblackbox/mcp-server`   | [apps/mcp-server/README.md](apps/mcp-server/README.md)           |
| Self-host share links                 | `@webblackbox/share-server` | [apps/share-server/README.md](apps/share-server/README.md)       |

## Quick Start

### Replay an Existing Archive

1. Open the hosted Player: https://webllm.github.io/webblackbox/
2. Click `Load Archive`.
3. Select a `.webblackbox` file or a compatible ZIP export.
4. Inspect the timeline, screenshots, network waterfall, console, storage, and generated artifacts.

### Record with the Chrome Extension

1. Download the latest extension package from [Chrome Web Store](https://chromewebstore.google.com/detail/webblackbox/heklgedghicnjglakenbmfilolcgknnp?hl=en) or [GitHub Releases](https://github.com/webllm/webblackbox/releases/latest).
2. Unzip the downloaded Chrome extension package locally.
3. Open `chrome://extensions/`.
4. Enable `Developer mode`.
5. Click `Load unpacked` and select the extracted extension directory.
6. Click the WebBlackbox toolbar icon, pick a recording profile (or leave `Auto` so site rules choose one), check the `Lite` / `Full` engine the profile preselects, and press `Start recording`.
7. Reproduce the issue (`Marker` or Ctrl/Cmd + Shift + M flags the moment), press `Stop`, then `Export` the `.webblackbox` archive with a passphrase of at least 8 characters (every archive is encrypted). Archive limits live in the options page under `Export & encryption`, and privacy scanner findings are shown inline after an export, never blocking it; the Sessions page lists, filters and bulk-exports past recordings.
8. Open the archive in your organization's Player, or in one you serve yourself (`pnpm player`). Set its address in the options page under `Export & encryption` → `Player URL` (or through the managed policy, see [docs/ENTERPRISE_ADMIN.md](docs/ENTERPRISE_ADMIN.md)) and the Sessions page offers `Export and open in Player`; the extension has no built-in Player address.

### Embed Lite Capture in Your App

```bash
npm install webblackbox
```

```ts
import { WebBlackboxLiteSdk } from "webblackbox";

const sdk = new WebBlackboxLiteSdk();
await sdk.start();
```

Full SDK details are in [packages/webblackbox/README.md](packages/webblackbox/README.md).

## What It Captures

WebBlackbox currently records 57 event types across 13 categories, including:

- User input and navigation
- Console logs and runtime errors
- Network requests, responses, failures, redirects, WebSocket, and SSE events
- DOM mutations and snapshots
- Screenshots and viewport changes
- Cookies, localStorage, sessionStorage, IndexedDB, Cache, and service worker lifecycle
- Web Vitals, long tasks, traces, CPU profiles, and heap snapshots

How much of each category is kept depends on the recording profile. The default profile records metadata only (no console text, bodies or input values); the `QA` and `Full capture` presets record console text, bodies and more, and `Full capture` records content raw (no masking), the raw DOM included. A recording stops if its profile changes after Start. See [Privacy Model](docs/PRIVACY.md).

For the full event schema, defaults, and message types, see [packages/protocol/README.md](packages/protocol/README.md).

## Archive Format

Sessions are exported as `.webblackbox` ZIP archives containing:

- `manifest.json` with only the format version and encryption parameters (plaintext)
- `meta/manifest.json` with the export metadata (encrypted)
- chunked NDJSON event streams
- time/request/text indexes
- content-addressed blobs for screenshots, DOM snapshots, and captured bodies
- integrity hashes for verification

Every archive is encrypted with AES-GCM and a PBKDF2-derived key from a passphrase of at least 8 characters; there is no plaintext export. Masking captured content follows each profile's redaction rules on a best-effort basis, with no guarantee that all sensitive data is removed. See [Privacy Model](docs/PRIVACY.md).

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
- [Chrome Web Store Disclosure Source](docs/CHROME_WEB_STORE_DISCLOSURE.md)
- [Architecture Notes](docs/ARCHITECTURE.md)
- [Performance Notes](docs/PERFORMANCE.md)

## Contributing

If you want to work on the monorepo itself, start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Web LLM
