# WebBlackbox Player

React-based session playback application for analyzing `.webblackbox` archives.

## Overview

The Player provides an interactive UI for exploring recorded web sessions with multiple analysis panels:

- **Timeline** — Chronological event visualization with filtering
- **Action Timeline** — Action cards with trigger/request/error/screenshot context
- **Network Waterfall** — HTTP request/response timing and details
- **Console** — Console log viewer with level filtering
- **Storage** — Cookie, localStorage, sessionStorage, IndexedDB, and cache operations
- **DOM Diff** — Visual comparison of DOM snapshots over time
- **Performance** — Web Vitals, long tasks, CPU profiles, heap snapshots
- **Screenshots** — Screenshot trail with pointer position overlay

## Technology Stack

- **React 19** — UI framework
- **@webblackbox/player-sdk** — Session analysis engine
- **@webblackbox/protocol** — Type definitions and validation
- **Custom CSS** — the token sheet `src/next/styles/next.css` (light and dark themes) with self-hosted Onest and JetBrains Mono; each feature ships its own stylesheet file
- **Vetted libraries** — Base UI, TanStack Virtual, react-resizable-panels, lucide-react, react-hotkeys-hook, Shiki (JavaScript regex engine), uPlot, jsdiff, microdiff, uFuzzy (see `LIBRARIES.md` in the rewrite notes and the PR #20 summary)
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

`build/` is what GitHub Pages and the extension e2e serve:

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

## GitHub Pages

Build a Pages-ready artifact:

```bash
cd apps/player
pnpm pages:build
```

This prepares `build/` for GitHub Pages by adding `.nojekyll` and `404.html`.

Deploy the Player to the repository Pages site:

```bash
cd apps/player
pnpm pages:deploy
```

The deploy script will:

- build the Player
- prepare the Pages artifact
- publish `apps/player/build` to the `gh-pages` branch
- verify `https://webllm.github.io/webblackbox/` is serving the Player

From the repo root you can also run:

```bash
pnpm player:pages:build
pnpm player:pages:deploy
```

## Usage

1. Open the Player application
2. Drag and drop a `.webblackbox` file (or use the file picker)
3. If the archive is encrypted, enter the passphrase
4. Explore the session using the interactive panels

## Features

### Event Timeline

- Chronological display of all captured events
- Filter by event type, level, and time range
- Full-text search across events
- Click events to view full details

### Action Timeline

- Card-based action spans from `getActionTimeline()`
- Trigger, duration, request/error counts, and screenshot context in one row
- Click-to-focus behavior links action cards to event details and request panel selection

### Network Panel

- Waterfall view of all HTTP requests
- Request/response headers and bodies
- Timing breakdown
- WebSocket and SSE stream analysis
- Generate curl/fetch commands for any request
- Export as HAR

### Console Panel

- All console output (log, info, warn, error, debug)
- Stack trace display for errors
- Source location links

### Storage Panel

- Cookie snapshots and operations
- localStorage/sessionStorage operations
- IndexedDB operations and snapshots
- Cache API operations
- Service Worker lifecycle events

### DOM Panel

- DOM snapshot timeline
- Diff view showing added, removed, and changed elements
- Path-based change tracking

### Performance Panel

- Core Web Vitals (LCP, CLS, INP, FID, TTFB)
- Long task detection
- CPU profile artifacts
- Heap snapshot artifacts
- Performance trace data

### Export

- Markdown bug reports
- Playwright test scripts
- Playwright mock scripts (with captured responses)
- GitHub issue templates
- Jira issue templates
- HAR export
- Share upload and link-based reload via `@webblackbox/share-server`

### Session Comparison

- Side-by-side comparison of two sessions
- Event count deltas by type
- Error and request rate comparison
- Storage operation comparison
- DOM snapshot diffing
