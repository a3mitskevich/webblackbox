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
- **Custom CSS** — classic Player styling in `src/styles.css`; the React player (`?ui=next`) uses the token sheet `src/next/styles/next.css` with self-hosted Onest and JetBrains Mono
- **class-variance-authority** — Component variants
- **Vite** — build, dev server with HMR and code splitting (the rest of the monorepo builds with tsup)

The React player (`?ui=next`, the rewrite in progress) is documented in [`src/next/README.md`](src/next/README.md): feature folders, rail-tab registry, per-feature i18n, store slices and e2e scenarios.

## Development

```bash
cd apps/player
pnpm dev        # Vite dev server with HMR on http://localhost:4177 (?ui=next for the React player)
```

The dev server relaxes the page CSP for React refresh (its inline preamble script) and the HMR websocket only; production builds keep `index.html` as written.

## Build

```bash
cd apps/player
pnpm build      # vite build → build/
pnpm serve      # serve build/ on http://localhost:4177
```

`build/` is what GitHub Pages and the extension e2e serve:

- `index.html` (from `apps/player/index.html`, the Vite entry; its CSP meta is the Player CSP) and `main.js`, a small entry with a stable name that picks the UI;
- lazily loaded chunks, CSS files and fonts under `assets/` with content hashes: the classic UI, the React UI, React, Zod and the archive SDK are separate chunks, so each UI loads only what it uses and heavy panels can `React.lazy` their own chunk;
- everything in `public/` copied as is (logo, iframe examples, font licences);
- `__PLAYER_VERSION__` from `package.json`, source maps next to every chunk;
- no `eval`/`Function`/WebAssembly and no runtime-injected `<style>`: CSS ships as files and fonts are never inlined as `data:` URIs (`e2e:player-next` scans the build and fails on any CSP violation, also under a policy without `style-src 'unsafe-inline'`).

`pnpm bundle:size` (repo root) checks the entry chunk and the total of all JS and CSS files against `bundle-size/budgets.json`.

## Bench (long recordings)

`pnpm bench` (here) builds a ten-minute synthetic recording of about 60k events (`scripts/lib/synthetic-long-session.mjs`: clicks with action spans, requests with bodies, failures, a SignalR socket, console, storage, routes, screenshots) and times opening it, the archive model, the rail derivations, the work every 120 ms playhead tick redoes while playing with "Follow playhead", and a jsdom render pass of the whole React player per tick on every rail tab (`scripts/bench/render-ticks.bench.tsx`). `pnpm bench:ci` (repo root) runs it with the recorder and pipeline benches and fails on the `player` limits in `benchmarks/ci-thresholds.json`. `BENCH_PLAYER_EVENTS`, `BENCH_PLAYER_DURATION_MS` and `BENCH_PLAYER_RENDER_TICKS` resize it; `BENCH_PLAYER_RENDER=0` skips the render pass.

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
