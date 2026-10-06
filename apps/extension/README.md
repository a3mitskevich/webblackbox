# WebBlackbox Chrome Extension

Chrome Manifest V3 extension that records web sessions in the tabs where you press Start, using the Chrome DevTools Protocol and a content script. Nothing is recorded in other tabs; see [Page injection](#page-injection) for whether the content script runs there at all.

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

#### Service Worker (`sw.js`)

- **Central coordinator** for all recording activity
- Manages CDP debugger connections via `@webblackbox/cdp-router`
- Instantiates `WebBlackboxRecorder` for event normalization
- Routes events between content scripts, CDP, and the pipeline
- Handles session lifecycle (start, stop, freeze, export)
- In `full`, captures storage snapshots, including cookies (`Network.getCookies`), through CDP
- Manages the offscreen document lifecycle

#### Content Script (`content.js`)

- Runs in every frame from `document_start` (default), or only in the recorded tab once a recording starts; see [Page injection](#page-injection)
- Stays idle until the tab is recorded: the capture agent (`content-agent.js`) loads on Start
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
- Handles chunking, compression, indexing, and blob storage
- Keeps recordings in IndexedDB, encrypted at rest with a per-browser-session key; unexported recordings do not survive a browser restart (see [Local Storage](../../docs/PRIVACY.md#local-storage))
- Generates `.webblackbox` ZIP archives on export
- Isolated from the main page for performance

#### Popup (`popup.html`)

- Quick controls for starting/stopping recording sessions; nothing is recorded until you press Start
- Recording profile selector (`Auto` = site rules) with the selected profile, matching rule and enterprise caps
- Engine switch (`Lite` / `Full`); a profile that records something only the Full engine captures (bodies, screenshots, tab video, whole console messages, CDP) locks it to `Full`
- Full-engine visual capture choice (screenshots, tab video, both, none) unless the profile pins one
- On Start, an offer to reload the page so the recording holds the page load ("Reload and Start" / "Start Without Reload"); the reload is issued only after the recording is live. It can be turned off in Options → Performance & sampling
- Notice when a recording was stopped because its profile changed (what changed, how to fix it), and a "create a profile" requirement with a link to Options when no profile exists
- Session status display
- Export trigger (asks for the passphrase)

#### Options Page (`options.html`)

- Full recorder configuration UI (these general fields edit the `Default` profile)
- Recording profiles: presets (read-only, duplicate to edit), capture level matrix, redaction / unmask lists, body filters, source maps, local retention of unexported recordings
- Delete any profile (presets and `Default` included; not policy profiles) and "Restore recommended profiles"; recording needs at least one profile
- Site rules that pick a profile (rules to a deleted profile are flagged and skipped), redaction sandbox
- Pointer & input: pointer and scroll sampling
- Sensitivity: masking rules (blocked selectors, header names, body keys)
- Performance & sampling: page injection mode (see [Page injection](#page-injection)), the reload offer on Start, ring buffer and freeze-on-error, sampling cadence, screenshot cadence and the network body capture byte cap
- Budgets: performance budget warnings and auto-freeze on breach
- Export & encryption: archive size cap and recent window, and the [Player URL](../../docs/ENTERPRISE_ADMIN.md#player-url) used by "Export and open in Player" (empty by default, which hides that action)
- Language: `Auto` (Chrome's language), English, Russian or Simplified Chinese
- Import / Export: profiles and rules as JSON, with a diff preview

#### Sessions Page (`sessions.html`)

- Browse, search and filter the recordings kept in this browser (live and stopped)
- View session metadata and statistics, add tags and notes
- Export (one or several), stop and delete sessions
- "Export and open in Player": exports the archive to the downloads folder, then opens the configured Player page; shown only when a Player URL is set

## Page injection

Settings → Performance & sampling → **Inject into pages** decides when `content.js` runs. Recording itself always happens only in tabs where you press Start.

| Mode                                          | What runs in pages you are not recording                                                                                                                                                   | Trade-off during a recording                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Always (record from page start)** (default) | `content.js` in every page and frame from `document_start`: one `content.ready` message to the service worker per frame load and a watcher that remembers password fields the page reveals | None: pages the recorded tab loads later (reload, navigation, new iframes) have the script before their own code                                                                                 |
| **Only when recording starts**                | Nothing                                                                                                                                                                                    | Pages the recorded tab loads later get the script right after they commit, which can be after their first scripts ran; password fields the page revealed before Start are not known as passwords |

In both modes nothing is recorded before Start: the capture agent loads only when a recording starts.

How it works:

- The manifest declares no static `content_scripts`. In the default mode the service worker registers `content.js` for `<all_urls>`, all frames, `document_start` with `chrome.scripting.registerContentScripts`; in "Only when recording starts" it unregisters it. The setting lives in `chrome.storage.local` under `webblackbox.injection` and is re-applied on every service worker start.
- On Start, `content.js` is injected into every frame of the tab. While a tab is recorded, each frame it commits (reload, navigation, an iframe added later) gets the script as soon as `webNavigation.onCommitted` reports it (`injectImmediately`). That is early, but unlike `document_start` it is not guaranteed to run before the page's own scripts.
- `content.js` runs once per frame: a second copy (registered plus injected) exits without touching the first, and the bundle is wrapped in its own scope so the second run cannot reset the running copy's state.
- Tab and navigation listeners are attached only while something records, so idle navigations do not wake the service worker in either mode.
- The store-safe build has no persistent host access, so it always injects on Start. It also has no `webNavigation`, so frames a recorded tab commits later (reload, navigation, a new iframe) do not get the script there.
- `<all_urls>` stays in both modes: `webRequest` (lite network baseline), `scripting.executeScript` and `registerContentScripts` need host access.

Idle cost, measured with `pnpm e2e:injection:idle` (50 tabs, each a page with one iframe, headless Chrome 153):

| Mode                       | Frames running `content.js` | Messages to the service worker | JS heap per tab |
| -------------------------- | --------------------------- | ------------------------------ | --------------- |
| Always                     | 100 of 100                  | 100 (`content.ready`)          | ~1.5 MB         |
| Only when recording starts | 0 of 100                    | 0                              | ~1.05 MB        |

## rrweb Status

`dom.rrweb.event` is emitted from lite-mode mutation summaries (`schema: rrweb-lite/v1`) and ingested through the standard content-event pipeline.

## Permissions

| Permission      | Purpose                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `debugger`      | CDP access for network, runtime, and page events                                      |
| `tabs`          | Tab information and URL access, other tabs of the recorded site                       |
| `scripting`     | Register the content script, or inject it on Start                                    |
| `storage`       | Extension settings, the per-browser-session at-rest key and stopped-session snapshots |
| `alarms`        | Delete stopped, unexported recordings when their retention ends                       |
| `offscreen`     | Pipeline processing in background                                                     |
| `tabCapture`    | Optional tab video in the Full engine                                                 |
| `webRequest`    | Network request monitoring                                                            |
| `webNavigation` | Re-inject the content script into frames a recorded tab commits                       |
| `downloads`     | Archive file download                                                                 |
| `<all_urls>`    | Host access for content script registration and injection, `webRequest`               |

This is the default (`dev`) build. The `store-safe` build (`node scripts/build-extension.mjs --profile store-safe`, after a `pnpm build` that writes the bundles) requests `activeTab`, `alarms`, `downloads`, `offscreen`, `scripting`, `storage` and `tabCapture` only: no `debugger` (so no Full engine), `tabs`, `webRequest`, `webNavigation` or host permissions.

## Keyboard Shortcuts

| Shortcut                   | Action             |
| -------------------------- | ------------------ |
| `Ctrl+Shift+M` (Win/Linux) | Create user marker |
| `Cmd+Shift+M` (Mac)        | Create user marker |

User markers are `user.marker` events that serve as bookmarks in the recording timeline. They always trigger the marker freeze reason.

## Build

```bash
cd apps/extension
pnpm build
pnpm build:release
pnpm package:chrome
pnpm verify
```

The build output is in the `build/` directory. The manifest is generated from `apps/extension/package.json` during the build, so there is no source `public/manifest.json` to keep in sync. The build also writes `managed-schema.json`, the `storage.managed_schema` for the [enterprise policy](../../docs/ENTERPRISE_ADMIN.md). Local `pnpm build` runs keep the stable development `key`, while `pnpm build:release` generates an unpacked release build without that `key`. `pnpm package:chrome` rebuilds the extension once, validates the generated manifest, and creates a distributable ZIP (Chrome Web Store upload layout, release manifest) in `dist/`. This fork is not published to the Chrome Web Store; install it from a build. Pass `--profile store-safe` to `scripts/build-extension.mjs` for the reduced-permission build described under [Permissions](#permissions). Packaging is pure Node.js, so it does not depend on a system `zip` binary being installed. `pnpm verify` runs the extension's lint, typecheck, test, and packaging pipeline in one command. You can override the ZIP path with `node scripts/build-extension.mjs --package --output ./dist/custom-name.zip`.

Build entries:

| Entry                          | Output                   | Description                    |
| ------------------------------ | ------------------------ | ------------------------------ |
| `src/sw/index.ts`              | `build/sw.js`            | Service worker                 |
| `src/content/index.ts`         | `build/content.js`       | Content script                 |
| `src/content/content-agent.ts` | `build/content-agent.js` | Capture agent, loaded on Start |
| `src/offscreen/index.ts`       | `build/offscreen.js`     | Offscreen document             |
| `src/popup/index.ts`           | `build/popup.js`         | Popup UI                       |
| `src/options/index.ts`         | `build/options.js`       | Options page                   |
| `src/sessions/index.ts`        | `build/sessions.js`      | Sessions page                  |
| `src/injected/index.ts`        | `build/injected.js`      | Injected page script           |

## E2E

- `pnpm e2e:fullchain:full` runs the full-mode end-to-end capture/export demo. `pnpm e2e:fullchain:lite:on-demand` (with a reload after Start) and `pnpm e2e:fullchain:full:on-demand` run it with injection on Start only (`WB_E2E_INJECTION_MODE=on-start`).
- `pnpm e2e:full:reload` checks "Reload and Start" in the Full engine: the session starts (CDP attached) before the reload, so the archive holds the page load from scratch; a start without the reload leaves the page alone.
- `pnpm e2e:completeness:full` (and `:reload`) records a realistic fixture site with Full capture and checks that the archive holds every body the policy asked for, or a `network.body.skipped` event saying why it is missing.
- `pnpm e2e:pointer` checks pointer capture (clicks with targets and geometry, right/middle clicks, long press, drag, wheel, hover, mousemove samples) in both engines.
- `pnpm e2e:tabs-context` checks that other tabs of the recorded site reach the archive and tabs of other sites never do.
- `pnpm e2e:sw-restart` terminates the service worker mid-run and checks that the next session starts, exports, and that orphaned IndexedDB sessions are swept.
- `pnpm e2e:ui` compares screenshots of the popup, options and sessions pages against `e2e-baselines/ui/` (`pnpm e2e:ui:update` refreshes them).
- `pnpm e2e:injection` checks over CDP which frames run `content.js` in both injection modes: before Start, after Start, in an iframe added later, after a reload and a navigation, in a tab that is not recorded and after Stop. `pnpm e2e:injection:idle` measures the idle cost of both modes with many tabs (`WB_E2E_INJECTION_BENCH_TABS`, default 50).
- `pnpm e2e:profile:qa` checks that a site rule selects the QA profile, that console text and value-masked JSON bodies reach the encrypted archive, that navigating to a host where the rules pick another profile stops the recording (reason in the archive, `!` badge, popup notice, nothing recorded afterwards), and that a plaintext export is refused.
- `pnpm e2e:at-rest` reads the extension's IndexedDB over CDP after a Full capture recording with planted secrets and checks that nothing in it is readable (every chunk and blob AES-GCM framed, session rows without URL or title), that the export still decrypts to the secrets and deletes the recording, that stopped recordings stay listed, stored and exportable after the service worker is stopped and more than 30 s pass, and that an unexported recording is gone after Chrome restarts on the same profile.
- `pnpm e2e:profile:full-capture` checks that the Full capture preset, chosen explicitly on a host without rules, records planted secrets (console, storage, URL token, headers, bodies, password field, WebSocket payload) and the raw DOM inside the encrypted archive, keeps doing so after the tab moves to another host, and that neither the secrets nor the site appear in the archive bytes.
- `pnpm e2e:realworld` and `pnpm e2e:realworld:ci` run the real-world stability matrix across lite/full startup paths, reload recovery, iframe/child-target capture, downloads/uploads, large response previews, export, and player replay. Use `pnpm e2e:realworld:quick` for the reduced local smoke slice.
- `pnpm e2e:memory:full` runs a synthetic long-session full-mode stress case and samples JS heap usage for the target page, service worker, and offscreen document.
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
5. Select the `apps/extension/build` directory

## Data Flow

### Recording

1. User clicks **Start** in popup (and, while the reload offer is on, chooses whether to reload the page)
2. Service worker resolves the profile (explicit choice or site rules), creates the session, initializes the recorder and, in `full` mode, attaches the CDP debugger; with "Reload and Start" it reloads the tab only once capture is live
3. `content.js` is already running in every frame (registered at `document_start`) or, with injection on Start only, is injected into every frame of the tab now; frames the tab commits later get it as they commit
4. Injected content capture begins streaming user events and DOM summaries
5. In `lite` mode, the injected script captures console and storage events (its fetch/XHR hooks are off; network comes from the `webRequest` baseline)
6. In `full` mode, CDP provides network, runtime exception, and page navigation events; `lite` uses a `webRequest` network baseline instead
7. Service worker normalizes all events through the recorder
8. Normalized events are batched and sent to the offscreen pipeline
9. Pipeline chunks, indexes, and stores events

### Export

1. User clicks **Export** in the popup or on the Sessions page and enters a passphrase (at least 8 characters)
2. The export policy from Options → Export & encryption is applied (defaults: `maxArchiveBytes=100MB`, `recentWindowMs=20 minutes`); in the Full engine, screenshots and tab video are included when the recording captured them
3. Service worker signals the pipeline to export with policy and the (required) passphrase
4. Pipeline finalizes indexes and generates the encrypted archive (format 2: event chunks, indexes, blobs, `privacy/manifest.json` and the full `meta/manifest.json` are encrypted; only the `manifest.json` envelope with the encryption parameters and `integrity/hashes.json` stay plaintext)
5. Service worker downloads the `.webblackbox` file via `chrome.downloads`; by default (per profile) the local recording is then deleted

### Freeze

When a freeze condition is detected (uncaught JS error / unhandled rejection, or user marker by default):

1. Recorder evaluates freeze policy
2. Service worker receives freeze notification
3. Notification is debounced to avoid UI thrash under repeated failures
4. Session keeps recording until the user explicitly stops/exports

## Configuration

The extension uses `@webblackbox/protocol`'s `RecorderConfig` for all settings. Default values are defined in `DEFAULT_RECORDER_CONFIG`, then mode-specific runtime safety tuning is applied:

- Supported capture modes (engines): `lite`, `full`
- `balanced` is not currently a shipped capture mode in this repo

- `lite`: lower sampling pressure + perf-trigger freeze disabled (`freezeOnNetworkFailure=false`, `freezeOnLongTaskSpike=false`)
  - page-side response-body sampling is disabled (`bodyCaptureMaxBytes=0`)
  - idle screenshots are disabled by default; enable `screenshotIdleMs` explicitly when needed
  - initial DOM/storage/screenshot capture is deferred briefly after start so the tab does not stall at record activation
  - hot listeners, observers, and page-side capture loops stay inactive until recording is enabled, even when `content.js` is loaded at `document_start` (the default page injection mode)
- `full`: same perf-freeze disable + stricter sampling/body-capture limits
  - page-side heavy capture loops (SnapDOM screenshots, outerHTML snapshots, storage snapshots) are skipped to reduce main-thread impact
  - `injected` console patching is not enabled (CDP is the primary source in full mode); fetch/XHR hooks are off in both modes
  - screenshot/trace artifacts are still captured from the SW/CDP pipeline path

Body capture sizing note:

- Protocol baseline (`DEFAULT_RECORDER_CONFIG`) sets `bodyCaptureMaxBytes=0`.
- Extension `lite` keeps `bodyCaptureMaxBytes=0` and disables runtime screenshots unless screenshot cadence is explicitly enabled.
- Extension `full` defaults clamp CDP-side body capture to `128 KiB` for safer long-session behavior.
- Options can still override the full-mode cap per profile.

The SW ↔ offscreen pipeline path also uses ingest batching with chunked drain to reduce message round-trips and avoid giant postMessage payloads under high event volume.

Users can still tune other settings through the Options page.

Recording profiles sit on top of this: the popup's engine switch picks the transport (`lite` / `full`), unless the profile needs the Full engine and locks it, and the profile chosen in the popup (or by a site rule) decides capture levels, redaction, sampling, body filters, visual capture, source maps and local retention. Every export is encrypted and the privacy scanner only reports, whatever a profile's `export` block says. Presets: `Lite`, `Full`, `QA`, `Full capture`, plus the editable `Default` and your own profiles. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#recording-profiles) and [docs/PRIVACY.md](../../docs/PRIVACY.md#recording-profiles).

## Requirements

- Chrome 125+
- Manifest V3
