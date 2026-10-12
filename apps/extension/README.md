# WebBlackbox Chrome Extension

Chrome Manifest V3 extension that records web sessions in the tabs where you press Record, using the Chrome DevTools Protocol and a content script. Nothing is recorded in other tabs; see [Page injection](#page-injection) for whether the content script runs there at all.

## Architecture

The extension consists of multiple main components:

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension                      │
│                                                          │
│  ┌───────────┐    ┌───────────┐    ┌────────────────┐   │
│  │  Injected  │    │  Content  │    │    Service     │   │
│  │  Script    │───→│  Script   │───→│    Worker      │   │
│  └───────────┘    └───────────┘    └───────┬────────┘   │
│  postMessage       chrome.runtime           │            │
│  (console,          .connect/.postMessage   │ CDP        │
│   storage)          (user, DOM)             │            │
│                                    ┌───────▼────────┐   │
│  ┌───────────┐                     │   Offscreen    │   │
│  │  Popup /  │                     │   Document     │   │
│  │  Options  │                     │   (Pipeline)   │   │
│  └───────────┘                     └────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Components

#### Service Worker (`background.js`)

- **Central coordinator** for all recording activity
- Manages CDP debugger connections via `@webblackbox/cdp-router`
- Instantiates `WebBlackboxRecorder` for event normalization
- Routes events between content scripts, CDP, and the pipeline
- Handles session lifecycle (start, stop, incident alerts, export)
- In `full`, captures storage snapshots, including cookies (`Network.getCookies`), through CDP
- Manages the offscreen document lifecycle

#### Content Script (`content-script.js`)

- Runs in every frame from `document_start` (default), or only in the recorded tab once a recording starts; see [Page injection](#page-injection)
- Stays idle until the tab is recorded: on Start it asks the service worker to inject the capture agent (`content-agent.js`) into its frame
- Captures user interaction events (click, input, scroll, keydown, etc.)
- Captures DOM mutations via MutationObserver
- Takes DOM snapshots at configured intervals
- Captures screenshots via SnapDOM
- Forwards events to the service worker via `chrome.runtime.connect` + `port.postMessage`

#### Injected Script (`injected.js`)

- Web-accessible resource injected into the page context
- Intercepts console API calls (log, warn, error, etc.)
- Monitors storage operations (localStorage, sessionStorage, IndexedDB); cookie snapshots come from the content script (`document.cookie`) and, in `full`, from CDP
- Communicates with the content script via `window.postMessage`

#### Offscreen Document

- Runs the `FlightRecorderPipeline` for event processing
- Handles chunking, indexing, and blob storage (chunks are gzip-compressed by default, with a per-chunk fallback to `none`)
- Keeps recordings in IndexedDB, encrypted at rest with a per-browser-session key; unexported recordings do not survive a browser restart (see [Local Storage](../../docs/PRIVACY.md#local-storage))
- Generates `.webblackbox` ZIP archives on export
- Isolated from the main page for performance

#### Popup (`popup.html`)

- One primary "Record" button; nothing is recorded until you press it. Above it, "Profile: Maximum · Change": the profile Record uses (the default profile, or the one a site rule picks, with enterprise caps), and a link to Options → Profiles where the choice lives. The profile decides the engine and the visual capture
- On Record, the page reload choice ("Page reload on Start"): by default a dialog with "Reload and Record" as the main choice, "Record Without Reload", and "Don't ask again (change it in Settings)", which stores the answer; the reload is issued only after the recording is live
- While recording: counters, Marker, Stop, and a warning when the recording fell back from Full to Light (why, and what is no longer captured)
- After Stop, the export step: "Export archive" (the main action) or "Later", which keeps the recording on the Sessions page; the passphrase is asked once and remembered until the browser closes ("Forget passphrase")
- Notice when a recording was stopped because its profile changed (what changed, how to fix it), and a "create a profile" requirement with a link to Options when no profile exists
- Session status display

#### Options Page (`options.html`)

- General recorder fields (masking, pointer, sampling, incidents) edit a `Default (custom)` profile kept from an earlier version; without one they are hidden and a note points to the profiles
- Recording profiles: the built-in `Maximum` (default) and `Light` (read-only, duplicate to edit), the default profile, capture level matrix, redaction / unmask lists, body filters, visual capture, source maps, local retention of unexported recordings (empty = keep until exported or deleted)
- Delete any profile (built-ins included; not policy profiles) and "Restore recommended profiles"; recording needs at least one profile
- Site rules that pick a profile (rules to a deleted profile are flagged and skipped)
- Sensitivity: masking rules (blocked selectors, header names, body keys) and the redaction sandbox
- Pointer & input: pointer and scroll sampling
- Performance & sampling: page injection mode (see [Page injection](#page-injection)), "Page reload on Start" ("Ask, reload by default", "Always reload", "Never reload"), incident alerts (flag uncaught errors), sampling cadence, screenshot cadence and the network body capture byte cap
- Budgets: performance budget warnings and flagging broken budgets
- Export & encryption: archive size cap and recent window, and the [Player URL](../../docs/ENTERPRISE_ADMIN.md#player-url) used by "Export and open in Player" (empty by default, which hides that action)
- Language: `Auto` (Chrome's language), English, Russian or Simplified Chinese
- Import / Export: profiles and rules as JSON, with a diff preview

#### Sessions Page (`sessions.html`)

- Browse, search and filter the recordings kept in this browser (live and stopped)
- View session metadata and statistics, add tags and notes
- Export (one or several, with the passphrase remembered for the browser session and a "Forget passphrase" button), stop and delete sessions; `sessions.html#export=<sid>` (the export notification) starts that recording's export
- Badges for recordings that are not exported yet and for recordings that fell back from Full to Light
- "Export and open in Player": exports the archive to the downloads folder, then opens the configured Player page; shown only when a Player URL is set

## Page injection

Settings → Performance & sampling → **Inject into pages** decides when `content-script.js` runs. Recording itself always happens only in tabs where you press Record.

| Mode                                          | What runs in pages you are not recording                                                                                                                                                          | Trade-off during a recording                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Always (record from page start)** (default) | `content-script.js` in every page and frame from `document_start`: one `content.ready` message to the service worker per frame load and a watcher that remembers password fields the page reveals | None: pages the recorded tab loads later (reload, navigation, new iframes) have the script before their own code                                                                                 |
| **Only when recording starts**                | Nothing                                                                                                                                                                                           | Pages the recorded tab loads later get the script right after they commit, which can be after their first scripts ran; password fields the page revealed before Start are not known as passwords |

In both modes nothing is recorded before Start: the capture agent loads only when a recording starts.

How it works:

- The manifest declares no static `content_scripts`. In the default mode the service worker registers `content-script.js` for `<all_urls>`, all frames, `document_start` with `chrome.scripting.registerContentScripts`; in "Only when recording starts" it unregisters it. The setting lives in `chrome.storage.local` under `webblackbox.injection` and is re-applied on every service worker start.
- On Start, `content-script.js` is injected into every frame of the tab. While a tab is recorded, each frame it commits (reload, navigation, an iframe added later) gets the script as soon as `webNavigation.onCommitted` reports it (`injectImmediately`). That is early, but unlike `document_start` it is not guaranteed to run before the page's own scripts.
- `content-script.js` runs once per frame: a second copy (registered plus injected) exits without touching the first, and the bundle is wrapped in its own scope so the second run cannot reset the running copy's state.
- Tab and navigation listeners are attached only while something records, so idle navigations do not wake the service worker in either mode.
- The store-safe build has no persistent host access, so it always injects on Start. It also has no `webNavigation`, so a recorded tab's frames are not re-injected as they commit: after a reload or navigation the script comes back only once the page finishes loading (while `activeTab` still covers it), and iframes added after load do not get it.
- `<all_urls>` stays in both modes: `webRequest` (lite network baseline), `scripting.executeScript` and `registerContentScripts` need host access.

Idle cost, measured with `pnpm e2e:injection:idle` (50 tabs, each a page with one iframe, headless Chrome 153):

| Mode                       | Frames running `content-script.js` | Messages to the service worker | JS heap per tab |
| -------------------------- | ---------------------------------- | ------------------------------ | --------------- |
| Always                     | 100 of 100                         | 100 (`content.ready`)          | ~1.5 MB         |
| Only when recording starts | 0 of 100                           | 0                              | ~1.05 MB        |

## rrweb Status

`dom.rrweb.event` is emitted from lite-mode mutation summaries (`schema: rrweb-lite/v1`) and ingested through the standard content-event pipeline.

## Permissions

| Permission      | Purpose                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `debugger`      | CDP access for network, runtime, and page events                                                     |
| `tabs`          | Tab information and URL access, other tabs of the recorded site                                      |
| `scripting`     | Register the content script, or inject it on Start                                                   |
| `storage`       | Extension settings, the per-browser-session at-rest key and stopped-session snapshots                |
| `alarms`        | Delete stopped, unexported recordings of profiles that set a retention time                          |
| `notifications` | Ask to export a stopped recording, and warn about a Full → Light fallback, while the popup is closed |
| `offscreen`     | Pipeline processing in background                                                                    |
| `tabCapture`    | Tab video (on in `Maximum`)                                                                          |
| `webRequest`    | Network request monitoring                                                                           |
| `webNavigation` | Re-inject the content script into frames a recorded tab commits                                      |
| `downloads`     | Archive file download                                                                                |
| `<all_urls>`    | Host access for content script registration and injection, `webRequest`                              |

This is the default (`dev`) build. The `store-safe` build (`pnpm build:store-safe`, the WXT mode `store-safe`) requests `activeTab`, `alarms`, `downloads`, `notifications`, `offscreen`, `scripting`, `storage` and `tabCapture` only: no `debugger` (so no Full engine: Full profiles fall back to Light), `tabs`, `webRequest`, `webNavigation` or host permissions.

## Keyboard Shortcuts

| Shortcut                   | Action             |
| -------------------------- | ------------------ |
| `Ctrl+Shift+M` (Win/Linux) | Create user marker |
| `Cmd+Shift+M` (Mac)        | Create user marker |

User markers are `user.marker` events that serve as bookmarks in the recording timeline. They always trigger the marker freeze reason.

## Build

```bash
cd apps/extension
pnpm build              # wxt build → .output/chrome-mv3/
pnpm build:store-safe   # wxt build --mode store-safe → .output/chrome-mv3-store-safe/
pnpm zip                # wxt zip → .output/<name>-<version>-chrome.zip
pnpm dev                # wxt (dev server, page HMR, extension auto-reload)
pnpm verify
```

The extension is built with [WXT](https://wxt.dev) and follows its defaults: entrypoints in `entrypoints/`, static files in `public/`, output in `.output/chrome-mv3/`, packaging with `wxt zip`. WXT writes `manifest.json` from the `manifest` in `wxt.config.ts` (fields in `scripts/lib/extension-build.mjs`), the entrypoints and the version in `apps/extension/package.json`; there is no source `manifest.json`. The build also writes `managed-schema.json`, the `storage.managed_schema` for the [enterprise policy](../../docs/ENTERPRISE_ADMIN.md), and fails when the manifest breaks what recording needs (permissions and host access per profile, the extension-page CSP, no web-accessible resources, no static content scripts) or when a script injected into pages is not one strict-mode anonymous IIFE. Builds carry no `key`: an unpacked build's extension id follows its path. The zip leaves out source maps. This fork is not published to the Chrome Web Store; install it from a build. `pnpm verify` runs the extension's lint, typecheck, test, and `zip` in one command. `pnpm dev` serves the pages from WXT's dev server; on WSL WXT cannot open Chrome, so load `.output/chrome-mv3-dev` by hand.

Entrypoints (each a thin wrapper that calls its `src/` module's start function from `main()`, or an HTML page):

| Entrypoint                      | Output (`.output/chrome-mv3/`)          | Description                                       |
| ------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `entrypoints/background.ts`     | `background.js`, `chunks/*`             | Service worker (`src/sw/index.ts`)                |
| `entrypoints/content-script.ts` | `content-script.js`                     | Content script (`src/content/index.ts`)           |
| `entrypoints/content-agent.ts`  | `content-agent.js`                      | Capture agent, injected into a frame that records |
| `entrypoints/injected.ts`       | `injected.js`                           | Page hooks, MAIN world (`src/injected/index.ts`)  |
| `entrypoints/offscreen.html`    | `offscreen.html`, `chunks/*`            | Offscreen document                                |
| `entrypoints/popup.html`        | `popup.html`, `chunks/*`, `assets/*`    | Popup UI                                          |
| `entrypoints/options.html`      | `options.html`, `chunks/*`, `assets/*`  | Options page (opens in a tab)                     |
| `entrypoints/sessions.html`     | `sessions.html`, `chunks/*`, `assets/*` | Sessions page                                     |

The service worker and the pages share code in `chunks/`. The three scripts that run in pages are self-contained IIFEs. `src/shared/extension-files.ts` lists the paths the service worker injects or opens, and the e2e scripts read them from there.

## E2E

- `pnpm e2e:fullchain:full` runs the full-mode end-to-end capture/export demo. `pnpm e2e:fullchain:lite:on-demand` (with a reload after Start) and `pnpm e2e:fullchain:full:on-demand` run it with injection on Start only (`WB_E2E_INJECTION_MODE=on-start`).
- `pnpm e2e:full:reload` checks "Reload and Record" in the Full engine: the session starts (CDP attached) before the reload, so the archive holds the page load from scratch; a start without the reload leaves the page alone.
- `pnpm e2e:completeness:full` (and `:reload`) records a realistic fixture site with `Maximum` and checks that the archive holds every body the policy asked for, or a `network.body.skipped` event saying why it is missing. `:heavy` adds a burst of JSON reports sent with about 220 MB of binary media, past Chrome's default 200 MB body buffer, and still expects no `not-retained` body.
- `pnpm e2e:pointer` checks pointer capture (clicks with targets and geometry, right/middle clicks, long press, drag, wheel, hover, mousemove samples) in both engines.
- `pnpm e2e:tabs-context` checks that other tabs of the recorded site reach the archive and tabs of other sites never do.
- `pnpm e2e:sw-restart` terminates the service worker mid-run — while a session records — and checks that the recording it left running is listed as interrupted and exports an archive player-sdk opens with its events and its interruption, that the next session starts and exports, and that orphaned IndexedDB sessions are swept.
- `pnpm e2e:ui` compares screenshots of the popup, options and sessions pages against `e2e-baselines/ui/` (`pnpm e2e:ui:update` refreshes them).
- `pnpm e2e:injection` checks over CDP which frames run `content-script.js` in both injection modes: before Start, after Start, in an iframe added later, after a reload and a navigation, in a tab that is not recorded and after Stop. `pnpm e2e:injection:idle` measures the idle cost of both modes with many tabs (`WB_E2E_INJECTION_BENCH_TABS`, default 50).
- `pnpm e2e:page-globals` checks in Lite and Full that recording adds no page (MAIN world) globals and replaces none: it compares every own property of `window` and its descriptor before Start with after Start, after captured actions and after Stop. Only the hooks' install flag and nonce setter are allowed (`ALLOWED_PAGE_GLOBALS`).
- `pnpm e2e:profile:rules` checks that a site rule selects a user QA-like profile, that console text and value-masked JSON bodies reach the encrypted archive, that navigating to a host whose rule picks another profile stops the recording (reason in the archive, `!` badge, popup notice, nothing recorded afterwards), and that a plaintext export is refused.
- `pnpm e2e:at-rest` reads the extension's IndexedDB over CDP after a `Maximum` recording with planted secrets and checks that nothing in it is readable (every chunk and blob AES-GCM framed, session rows without URL or title), that the export still decrypts to the secrets and deletes the recording, that stopped recordings stay listed, stored and exportable after the service worker is stopped and more than 30 s pass, and that an unexported recording is gone after Chrome restarts on the same profile.
- `pnpm e2e:profile:maximum` checks that `Maximum`, the default with no profiles stored, records planted secrets (console, storage, URL token, headers, bodies, password field, WebSocket payload) and the raw DOM, unmasked, inside the encrypted archive, keeps doing so after the tab moves to another host, and that neither the secrets nor the site appear in the archive bytes.
- `pnpm e2e:capture-fallback` detaches the debugger mid-recording and checks that the recording switches to Light and goes on, that the archive (`meta.config.captureFallback`, `sys.debugger.detach`) and its completeness report say when and why, and that it exports.
- `pnpm e2e:kept-after-stop` checks that a stopped, unexported recording waits for its export (export prompt, `SAVE` badge) and is still listed and exportable after the old 10-minute retention would have deleted it.
- `pnpm e2e:realworld` and `pnpm e2e:realworld:ci` run the real-world stability matrix across lite/full startup paths, reload recovery, iframe/child-target capture, downloads/uploads, large response previews, export, and player replay. Use `pnpm e2e:realworld:quick` for the reduced local smoke slice.
- `pnpm e2e:memory:full` runs a synthetic long-session full-mode stress case and samples JS heap usage for the target page, service worker, and offscreen document.
- `pnpm e2e:memory:full` and the fullchain runs (including `pnpm e2e:completeness:full`) also print the bytes that crossed the SW ↔ offscreen port (`Port traffic`): the JSON size per direction and per op, and how many wire bytes each byte of binary payload cost. They fail when a binary payload costs more than base64 plus a small envelope. The worker counts only while `globalThis.__WEBBLACKBOX_PORT_TRAFFIC__ = true`.
- `pnpm e2e:isolation:full` records two tabs in full mode at the same time (cross-site, with an iframe, a worker and a popup in one tab, then same-site) and checks in each decrypted archive that the tab's own child-target activity is there and no other tab's events are.
- `pnpm e2e:perf:lite` runs a lite-mode A/B stress matrix that now covers same-page request/hover pressure, real document navigation, iframe-heavy interaction, and contenteditable typing before comparing baseline vs active-recording budgets.
- `pnpm e2e:perf:lite:ci` runs a reduced version of the same lite perf matrix so CI can gate regressions without paying the full local-runtime cost.
- Useful env vars for the memory regression script: `WB_E2E_STRESS_REQUESTS`, `WB_E2E_STRESS_CONCURRENCY`, `WB_E2E_MEMORY_SAMPLE_MS`, `WB_E2E_OFFSCREEN_FINAL_GROWTH_MB`, `WB_E2E_SW_FINAL_GROWTH_MB`.
- Useful env vars for the lite perf regression script: `WB_E2E_PERF_REQUESTS`, `WB_E2E_PERF_CONCURRENCY`, `WB_E2E_PERF_PAYLOAD_BYTES`, `WB_E2E_PERF_IFRAME_COUNT`, `WB_E2E_PERF_EDITOR_ROUNDS`, `WB_E2E_PERF_NAV_ROUNDS`, `WB_E2E_PERF_NAV_WAIT_MS`, `WB_E2E_PERF_AFTER_START_SETTLE_MS`, `WB_E2E_PERF_FETCH_P95_DELTA_MS`, `WB_E2E_PERF_HOVER_P95_DELTA_MS`.

## Loading in Chrome

1. Run `pnpm build` in the extension directory
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the `apps/extension/.output/chrome-mv3` directory

## Data Flow

### Recording

1. User clicks **Record** in the popup (and, unless "Page reload on Start" is set to always or never, chooses whether to reload the page)
2. Service worker resolves the profile (site rules, then the default profile), creates the session in the profile's engine, initializes the recorder and, in `full` mode, attaches the CDP debugger (on a restricted page, or when the attach fails, it records in `lite` and says so); with "Reload and Record" it reloads the tab only once capture is live
3. `content-script.js` is already running in every frame (registered at `document_start`) or, with injection on Start only, is injected into every frame of the tab now; frames the tab commits later get it as they commit
4. Injected content capture begins streaming user events and DOM summaries
5. In `lite` mode, the injected script captures console and storage events (its fetch/XHR hooks are off; network comes from the `webRequest` baseline)
6. In `full` mode, CDP provides network, runtime exception, and page navigation events; `lite` uses a `webRequest` network baseline instead
7. Service worker normalizes all events through the recorder
8. Normalized events are batched and sent to the offscreen pipeline
9. Pipeline chunks, indexes, and stores events

### Export

1. User clicks **Export archive** in the popup's export step (or **Export** on the Sessions page) and, on the first export of the browser session, enters a passphrase (at least 8 characters); the service worker remembers it until the browser closes
2. The export policy from Options → Export & encryption is applied (default: the whole session — size limit and recent window are 0, off); in the Full engine, screenshots and tab video are included when the recording captured them. Whatever a limit leaves out is recorded in the archive, and the Player's "About this recording" shows it
3. Service worker signals the pipeline to export with policy and the (required) passphrase
4. Pipeline finalizes indexes and generates the encrypted archive (format 2: event chunks, indexes, blobs, `privacy/manifest.json` and the full `meta/manifest.json` are encrypted; only the `manifest.json` envelope with the encryption parameters and `integrity/hashes.json` stay plaintext)
5. Service worker downloads the `.webblackbox` file via `chrome.downloads`; by default (per profile) the local recording is then deleted. A recording that is not exported stays (badge `SAVE`) until it is exported or deleted

The toolbar badge shows one notice at a time, most urgent first: `REC` while recording (`LITE` after a Full → Light fallback), `ERR` after an incident, `!` for a profile-change notice, `SAVE` while a stopped recording waits for its export, then the new-version arrow.

### Freeze

When a freeze condition is detected (uncaught JS error / unhandled rejection, or user marker by default):

1. Recorder evaluates freeze policy
2. Service worker receives freeze notification
3. Notification is debounced to avoid UI thrash under repeated failures
4. The alert shows as an ERR badge on the toolbar icon, on the page indicator and as an incident line in the popup
5. Session keeps recording until the user explicitly stops/exports; nothing is trimmed or preserved by a freeze

The extension keeps no in-memory ring buffer (`ringBufferMinutes: 0`): the pipeline stores every event, so an in-memory copy would only cost service worker memory.

## Configuration

The extension uses `@webblackbox/protocol`'s `RecorderConfig` for all settings. Default values are defined in `DEFAULT_RECORDER_CONFIG`, then mode-specific runtime safety tuning is applied:

- Supported capture modes (engines): `lite`, `full`
- `balanced` is not currently a shipped capture mode in this repo

- `lite`: lower sampling pressure + perf-trigger freeze disabled (`freezeOnNetworkFailure=false`, `freezeOnLongTaskSpike=false`)
  - page-side response-body sampling is disabled (`bodyCaptureMaxBytes=0`)
  - idle screenshots are disabled by default; enable `screenshotIdleMs` explicitly when needed
  - initial DOM/storage/screenshot capture is deferred briefly after start so the tab does not stall at record activation
  - hot listeners, observers, and page-side capture loops stay inactive until recording is enabled, even when `content-script.js` is loaded at `document_start` (the default page injection mode)
- `full`: same perf-freeze disable + stricter sampling/body-capture limits
  - page-side SnapDOM screenshots and storage snapshots are skipped (CDP takes screenshots); DOM snapshots and mutation summaries run at the default DOM level (`masked`, recorded like `allow` through the profile's masking rules) and stop only under `wireframe` or `off`
  - `injected` console patching is not enabled (CDP is the primary source in full mode); fetch/XHR hooks are off in both modes
  - screenshot/trace artifacts are still captured from the SW/CDP pipeline path

Body capture sizing note:

- Protocol baseline (`DEFAULT_RECORDER_CONFIG`) sets `bodyCaptureMaxBytes=0`.
- Extension `lite` keeps `bodyCaptureMaxBytes=0` and disables runtime screenshots unless screenshot cadence is explicitly enabled.
- Extension `full` defaults to `1 MiB` per body (the same as the `Maximum` profile). The options page and profiles accept up to `8 MiB` (one shared ceiling, `shared/body-capture-limits.ts`); a body over the limit keeps its first bytes and is flagged `truncated`, and the Player shows "Cut at N of M".
- When a session keeps bodies, `Network.enable` gets buffer sizes from the body limit (`sw/network-buffers.ts`): a total buffer of 256× the limit (Chrome's 200 MB at least, 512 MiB at most), a per-response buffer of 16× the limit (Chrome's 20 MB at least, 64 MiB at most) and request bodies up to the limit inline. Chrome then keeps bodies long enough to read them on heavy pages instead of evicting them (`not-retained`).
- A body the browser keeps is read whole and cut at the limit (large reads run one at a time). A response that declares a length past the per-response buffer is streamed for its start (`Network.streamResourceContent`, up to 64 MiB, four at once); otherwise the skip says why (`too-large` with the size and a detail).

The SW ↔ offscreen pipeline path also uses ingest batching with chunked drain to reduce message round-trips and avoid giant postMessage payloads under high event volume.

Users can still tune other settings through the Options page.

Recording profiles sit on top of this: the profile in effect (the default profile, `Maximum` out of the box, or the one a site rule picks) decides the transport (`lite` / `full`; a profile that needs the Full engine always gets it), capture levels, redaction, sampling, body filters, visual capture, source maps and local retention. When Full cannot run or stops, the recording falls back to `lite` and records why. Every export is encrypted and the privacy scanner only reports, whatever a profile's `export` block says. Built-ins: `Maximum` and `Light`, plus your own profiles (and a `Default (custom)` kept from an earlier version). See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#recording-profiles) and [docs/PRIVACY.md](../../docs/PRIVACY.md#recording-profiles).

## Requirements

- Chrome 125+
- Manifest V3
