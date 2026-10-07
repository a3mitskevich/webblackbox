# Performance Benchmarks

This document explains how to benchmark the recorder, pipeline and Player, and which performance gates CI runs, so regressions are visible before release.

## Why this exists

WebBlackbox sessions can run for long periods and produce large archives. We track:

- ingest throughput (events/sec)
- export latency (ms)
- archive size impact after filtering
- ring buffer pruning cost

In addition, runtime capture now prefers lower page-thread overhead:

- the extension has two capture engines, `lite` and `full` (`apps/extension/src/shared/mode-profile.ts`); recording profiles (Default, Lite, Full, QA, Full capture and custom ones) run on top of one of them
- extension `lite` never captures request/response bodies: the mode boundary sets the body budget to 0, and a profile that asks for bodies locks the engine to `full`
- extension `lite` defers heavy start-of-recording DOM/storage/screenshot capture to avoid foreground-tab activation jank
- extension `lite` keeps idle screenshots disabled by default; set a positive `screenshotIdleMs` only when screenshots are explicitly allowed
- extension `content.js` is present at `document_start` by default, but its hot listeners and observers stay dormant until recording becomes active; with the "Only when recording starts" injection setting it does not run in unrecorded pages at all (see `apps/extension/README.md#page-injection`, measured by `e2e:injection:idle`)
- extension `content.js` itself is small (budgeted at 30,000 B / 10,000 B gzip); the capture agent (`content-agent.js`) and its strings are imported only when recording starts
- extension `full` mode keeps heavy screenshot/DOM/storage capture on the SW/CDP side
- content-script side in `full` mode skips page-thread SnapDOM screenshots, and skips DOM/storage snapshot loops unless the profile records the raw DOM or page storage
- the extension never installs fetch/xhr hooks in the page (network comes from `webRequest` in `lite` and CDP in `full`); in `full` mode the injected console/error hooks stay inactive and only the storage hooks emit, when the profile records page storage
- pipeline ingest is batched across SW ↔ offscreen and webblackbox recorder ↔ pipeline boundaries
- pipeline drain is chunked to avoid giant `postMessage` payloads during stop/export
- in the `webblackbox` lite SDK, injected network body capture is rate-limited (45 bodies and 4 MB per minute) and gated by runtime config to reduce page jank
- extension `e2e:perf:lite` now gates not only request/hover pressure but also real document navigation, iframe-heavy pages, and contenteditable typing

## Quick start

From repo root:

```bash
pnpm bench
```

Run only recorder benchmarks:

```bash
pnpm bench:recorder
```

Run only pipeline benchmarks:

```bash
pnpm bench:pipeline
```

Run only the Player benchmark:

```bash
pnpm bench:player
```

Run CI regression checks (uses conservative fixed thresholds from `benchmarks/ci-thresholds.json`; writes `benchmarks/last-ci-report.json`):

```bash
pnpm bench:ci
```

## Recorder benchmark

Command:

```bash
pnpm --filter @webblackbox/recorder bench
```

It reports:

- ring buffer baseline (`splice` prune) vs optimized head-index prune
- `WebBlackboxRecorder.ingest` throughput
- `snapshotRingBuffer()` latency
- retained event count and heap delta

Environment knobs:

- `BENCH_RING_EVENTS` (default `120000`)
- `BENCH_RECORDER_EVENTS` (default `160000`)

## Pipeline benchmark

Command:

```bash
pnpm --filter @webblackbox/pipeline bench
```

It measures:

- long-session ingest throughput and chunk count
- full export latency/size
- filtered export latency/size using the same defaults as extension/webblackbox policy:
  - screenshots disabled
  - archive cap `100 MB`
  - recent window `20 minutes`
- parse latency and reduction ratios

Environment knobs:

- `BENCH_PIPELINE_EVENTS` (default `25000`)
- `BENCH_PAYLOAD_BYTES` (default `900`)
- `BENCH_SCREENSHOT_INTERVAL` (default `120`)
- `BENCH_BLOB_POOL` (default `24`)
- `BENCH_BLOB_BYTES` (default `24576`)
- `BENCH_MAX_ARCHIVE_MB` (default `100`)
- `BENCH_RECENT_MINUTES` (default `20`)

## Player benchmark

Command:

```bash
pnpm --filter @webblackbox/player bench
```

It builds a synthetic ~10-minute archive, opens it with the Player SDK, builds the Player's archive model and rail derivations, then replays it in 120 ms ticks with "Follow playhead" on and times the per-tick work and the React re-render per tick (jsdom).

Environment knobs:

- `BENCH_PLAYER_EVENTS` (default `60000`)
- `BENCH_PLAYER_DURATION_MS` (default `600000`)
- `BENCH_PLAYER_RENDER_TICKS` (default `120`)
- `BENCH_PLAYER_RENDER=0` skips the render pass (`bench:ci` always runs it)

## CI gates

`pnpm bench:ci` (`scripts/bench-regression-check.mjs`) runs the three benchmarks with smaller inputs (`BENCH_RING_EVENTS=60000`, `BENCH_RECORDER_EVENTS=80000`, `BENCH_PIPELINE_EVENTS=12000`, `BENCH_PLAYER_EVENTS=60000`) and fails on any threshold in `benchmarks/ci-thresholds.json`:

| Check                                  | Threshold           |
| -------------------------------------- | ------------------- |
| Recorder optimized ring prune          | >= 100,000 ops/s    |
| Recorder ingest                        | >= 50,000 ops/s     |
| Recorder `snapshotRingBuffer()`        | <= 20 ms            |
| Pipeline ingest                        | >= 20,000 ops/s     |
| Pipeline full export                   | <= 10,000 ms        |
| Pipeline filtered export               | <= 8,000 ms         |
| Pipeline archive drop ratio (filtered) | >= 0.2              |
| Player bench archive size              | >= 50,000 events    |
| Player open / model build              | <= 1,500 / 4,000 ms |
| Player rail derivations                | <= 1,500 ms         |
| Player tick p95 / render tick p95      | <= 4 / 100 ms       |

The render pass also fails when any panel crashes on the long archive.

Other performance gates in CI (`.github/workflows/ci.yml`):

- **Bundle size** (`pnpm bundle:size`, `bundle-size/budgets.json`): absolute budgets for the bundles that run in recorded pages (`injected.js` 32,000 B / 11,000 B gzip, `content.js` 30,000 B / 10,000 B gzip, `content-agent.js` 190,000 B / 60,000 B gzip; none may contain Zod), and a delta check against the base branch's CI build for the service worker, offscreen document, extension pages, the Player `main.js` and the library bundles: a bundle fails when it grows by more than 8% and more than 2 KB, unless the PR explains it with a `size-increase:` line. See [bundle-size/README.md](../bundle-size/README.md).
- **Lite page overhead** (`e2e:perf:lite:ci`, `apps/extension/scripts/e2e-lite-perf-regression.mjs`): compares a baseline run without recording to recorded runs on request pressure with hover, interaction rounds, iframe-heavy pages, contenteditable typing and real navigations. Timing budgets allow `recorded <= max(baseline × ratio, baseline + delta, delta)`, for example fetch p95 ×1.6 / +30 ms, total duration ×1.45 / +900 ms, rAF gap p95 ×1.35 / +8 ms, navigation p50 ×1.7 / +80 ms; long-task budgets are absolute deltas only (`recorded <= baseline + delta`, e.g. long-task total +200 ms). A budget passes when one of up to 3 recorded attempts meets it (`apps/extension/scripts/lib/perf-budgets.mjs`); every limit can be overridden with a `WB_E2E_PERF_*` variable.
- **Full memory** (`e2e:memory:full:ci`, `apps/extension/scripts/e2e-full-memory-regression.mjs`): after a request stress run in `full` mode, final heap growth must stay within 20 MB in the offscreen document and 12 MB in the service worker (`WB_E2E_OFFSCREEN_FINAL_GROWTH_MB`, `WB_E2E_SW_FINAL_GROWTH_MB`).

Because benchmark noise exists across machines, compare trends on the same runner class instead of absolute numbers from laptops.

## Runtime Perf Logs

For live troubleshooting on real pages, enable optional perf logs:

- Extension SW: open service worker devtools, run `globalThis.__WEBBLACKBOX_PERF__ = true`
- Web SDK page: run `window.__WEBBLACKBOX_PERF__ = true`

When enabled, logs include:

- slow offscreen requests (`[WebBlackbox][perf] offscreen request`)
- pipeline buffer flushes (`[WebBlackbox][perf] pipeline buffer flushed`)
- dropped best-effort service worker queue tasks
- dropped low-priority events under backpressure (page-side capture agent)
