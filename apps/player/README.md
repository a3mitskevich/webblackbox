# WebBlackbox Player

React-based session playback application for analyzing `.webblackbox` archives.

## Overview

The Player replays a recording on a stage (the tab video, or the screenshot trail, with the recorded cursor, clicks and the inspected element drawn over it), a timeline with lanes under it, and a rail of analysis tabs (keys `1`–`8`):

- **Activity** — the action → consequences feed, with "Errors only" and "Hide third-party", plus the problems strip above the stage
- **Network** — the request table and request details
- **Console** — console output and errors with source-mapped stacks
- **Realtime** — WebSocket and SSE connections as a conversation of sent and received messages
- **Storage** — storage at the playhead and the log of writes
- **Tabs** — the other tabs of the recorded site that were open in parallel
- **Perf** — web vitals, charts and recorded performance artifacts
- **Compare** — the open recording against a second one

## Technology Stack

- **React 19** — UI framework
- **@webblackbox/player-sdk** — Session analysis engine
- **@webblackbox/protocol** — Type definitions and validation
- **Custom CSS** — the token sheet `src/next/styles/next.css` (light and dark themes) with self-hosted Onest and JetBrains Mono; each feature ships its own stylesheet file
- **Vetted libraries** — Base UI, TanStack Virtual, react-resizable-panels, lucide-react, react-hotkeys-hook, Shiki (JavaScript regex engine), uPlot, jsdiff, microdiff, uFuzzy (see the PR #20 summary)
- **Vite** — build, dev server with HMR and code splitting (the rest of the monorepo builds with tsup)

The UI is React only (function components, hooks, one external store read with `useSyncExternalStore`); `src/main.ts` just mounts it. Its layout, feature folders, rail-tab registry, per-feature i18n, store slices and e2e scenarios are documented in [`src/next/README.md`](src/next/README.md). Nothing in `src/` renders HTML strings or builds DOM by hand: `src/no-dom-rendering.test.ts` fails on `innerHTML`, `dangerouslySetInnerHTML`, `document.createElement` and the like.

## Development

```bash
cd apps/player
pnpm dev        # Vite dev server with HMR on http://localhost:4177
```

The dev server relaxes the page CSP for React refresh (its inline preamble script), the HMR websocket and the CSS Vite injects as `<style>` in development only; production builds keep `index.html` as written.

## Build

```bash
cd apps/player
pnpm build      # vite build → build/
pnpm serve      # serve build/ on http://localhost:4177
```

From the repo root, `pnpm player` does both (build, then serve on port 4177).

`build/` is what you host and what the extension e2e serves:

- `index.html` (from `apps/player/index.html`, the Vite entry; its CSP meta is the Player CSP) and `main.js`, the entry with a stable name (the app shell);
- chunks, CSS files and fonts under `assets/` with content hashes: React, Zod and the archive SDK are named chunks, and heavy panels (`React.lazy`) and libraries such as Shiki and uPlot load their own chunk on first use;
- everything in `public/` copied as is (logo, iframe examples, font licences);
- `__PLAYER_VERSION__` from `package.json`, source maps next to every chunk;
- no `eval`/`Function`/WebAssembly and no runtime-injected `<style>`: the CSP is `script-src 'self'; style-src 'self'` (no `'unsafe-inline'`), CSS ships as files and fonts are never inlined as `data:` URIs (`e2e:player` scans the build and fails on any CSP violation).

`pnpm bundle:size` (repo root) checks the entry chunk and the total of all JS and CSS files against `bundle-size/budgets.json`.

## E2E

```bash
WB_E2E_CHROME_BIN=/path/to/chrome pnpm --filter @webblackbox/player e2e:player
```

`e2e:player` builds the Player, opens a synthetic encrypted archive in Chrome over CDP and runs the shell scenarios (`scripts/e2e-next/shell.mjs`) and every feature's scenarios (`src/next/features/<feature>/<feature>.e2e.mjs`) through `data-testid` hooks only. `WB_E2E_PLAYER_FEATURES=network` runs one feature's scenarios; `WB_E2E_SCREENSHOTS_DIR` captures 1440/1920, light/dark, EN/RU screenshots; `WB_E2E_REAL_ARCHIVE` (+ `WB_E2E_REAL_PASSPHRASE`) also opens a real archive (keep its screenshots local).

## Bench (long recordings)

`pnpm bench` (here) builds a ten-minute synthetic recording of about 60k events (`scripts/lib/synthetic-long-session.mjs`: clicks with action spans, requests with bodies, failures, a SignalR socket, console, storage, routes, screenshots) and times opening it, the archive model, the rail derivations, the work every 120 ms playhead tick redoes while playing with "Follow playhead", and a jsdom render pass of the whole React player per tick on every rail tab (`scripts/bench/render-ticks.bench.tsx`). `pnpm bench:ci` (repo root) runs it with the recorder and pipeline benches and fails on the `player` limits in `benchmarks/ci-thresholds.json`. `BENCH_PLAYER_EVENTS`, `BENCH_PLAYER_DURATION_MS` and `BENCH_PLAYER_RENDER_TICKS` resize it; `BENCH_PLAYER_RENDER=0` skips the render pass.

## Self-hosting

There is no hosted Player for this fork: build it and serve `build/` yourself. The public Player at `https://webllm.github.io/webblackbox/` runs upstream code, which reads only archive format 1, so it cannot open the format-2 archives this fork exports (every export is encrypted).

- **Any static host.** `build/` is plain files with relative URLs (Vite `base: "./"`), so it also works from a sub-path. No server-side code is needed.
- **A secure context.** The archive's integrity hashes are checked and its files decrypted with the Web Crypto API (`crypto.subtle`), which browsers expose only on `https://` pages and on `http://localhost` / `127.0.0.1`. On plain `http://` elsewhere, no archive opens ("Web Crypto API or Node crypto is required for SHA-256 hashing.").
- **CSP.** The policy ships in the `<meta http-equiv="Content-Security-Policy">` of `index.html`; it needs no `'unsafe-inline'` and no `eval`. If your server adds its own `Content-Security-Policy` header, both policies apply, so the header must allow at least `script-src 'self'`, `style-src 'self'`, `img-src`/`media-src 'self' blob: data:` and `connect-src 'self' http: https:` (share-server downloads).
- **The extension.** Set the Player URL in the extension's Options (or the `playerUrl` managed policy) to your Player: `https:`, or `http:` on localhost / 127.0.0.1. "Export and open in Player" then opens that page; the archive stays in the downloads folder and is dropped into the Player.

### GitHub Pages

```bash
cd apps/player
pnpm pages:build    # build, then add .nojekyll and 404.html to build/
pnpm pages:deploy   # pages:build, then publish build/ to the gh-pages branch of the origin remote
```

`pages:deploy` waits until `--site-url` serves the Player. Its default is the upstream site (`https://webllm.github.io/webblackbox/`): pass `--site-url https://<owner>.github.io/<repo>/` for your own Pages site, or `--skip-verify`. Other flags: `--remote`, `--branch`, `--skip-build`, `--message`. From the repo root: `pnpm player:pages:build`, `pnpm player:pages:deploy`.

The `player-pages` job of `.github/workflows/release-assets.yml` runs `pages:deploy` when a GitHub release is published; it also expects the upstream site URL. This fork publishes no releases and has no Pages site.

## Usage

1. Open the Player application
2. Drop a `.webblackbox` (or `.zip`) file anywhere on the page, or use the file button
3. Enter the passphrase when the archive is encrypted (every current export is). A wrong one asks again; the passphrase is never stored
4. Explore the session: play, scrub the timeline, and switch rail tabs

A `?share=<id or URL>` link opens a shared recording from a share server. Such a link is untrusted: it never changes the saved share server or API key, and an archive from an origin other than this page, the default or the saved server opens only after you confirm it. The URL hash keeps the playhead, selection and tab (`#t=10.89&sel=req:…&tab=network`).

The Player opens archive formats 1 and 2 through `@webblackbox/player-sdk`, which treats every archive as untrusted input (schema validation and size caps on load, see [its README](../../packages/player-sdk/README.md#opening-untrusted-archives)).

## Features

### Stage and timeline

- The tab video (kept in step with the player clock), or the screenshot trail when the recording has no video
- Cursor, trail and click ripples (double, right, hold) drawn in recorded viewport coordinates
- Timeline lanes (the pointer lane shows rage / dead clicks) with "Expand lanes"; `[` and `]` (or Shift+drag) mark a time range that narrows Activity, Network and Console

### Activity and inspector

- The action → consequences feed, filterable, with "Errors only", "Hide third-party" and a frame scope (main / iframes)
- The problems strip above the stage
- Event inspector (Enter): the event's target, its selector (copy) and its box, outlined on the stage

### Network

- Request table with details tabs: Headers, Payload, Response, Timing, Initiator, Messages
- JSON tree, highlighted code (Shiki) and hex views of bodies
- Copy as curl / Copy as fetch
- Replay: sends the request again from the Player page without cookies or referrer (refused when the body was not recorded in full) and compares the status and the body hash with the recording

### Realtime

- WebSocket and SSE connections with their messages as a conversation (sent / received), SignalR messages labelled
- Full payloads load on demand; cut payloads are marked

### Console

- Console output and errors by level (error, warning, info, log), "Group similar", "Hide third-party"
- Source-mapped stacks: maps embedded in the archive are used first; `.map` files, a build folder or a symbol server URL can be added for the rest

### Storage

- Local, session, cookies, IndexedDB, Cache and service worker
- State at the playhead (from the snapshot plus the writes after it) and the log of writes, with value diffs

### Tabs

- The other tabs of the recorded site open at the playhead (same origin / same site, flags) and their changes (opened, navigated, left, closed, activated)

### Perf

- Web vitals at the playhead (LCP, CLS, INP, TTFB)
- Charts of requests in flight, failures, transfer and long tasks, with the playhead
- Recorded artifacts (trace, CPU profile, heap snapshot) to download

### Compare

- Opens a second archive (archive B, with its own passphrase) and sets endpoints, failures, p95 timings, event types and storage side by side
- Endpoint regressions; a picked endpoint shows its response header and body diff

### Generate

From the header "Generate" menu or the command palette, for the selected time range or the whole session:

- Playwright test, and Playwright test with mocks (recorded responses served by `page.route`)
- Markdown bug report (also copied in one step)
- HAR
- GitHub and Jira issue payloads
- Download the clean tab video: as recorded, without the Player's overlay (one entry per part of a restarted recording)

### Share

- The header's Share button uploads the open recording, still encrypted, to an `@webblackbox/share-server`, or opens a shared one by link or id

### Command palette, keys and language

- Ctrl+K / ⌘K opens the command palette: commands, events and requests, fuzzy-matched
- `?` lists the keyboard shortcuts (physical keys, so they work on a Russian layout)
- The header language switch (English, Русский, 中文) re-renders the UI in place, without a reload
