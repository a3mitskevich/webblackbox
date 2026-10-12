# Architecture

This document describes the high-level architecture of WebBlackbox, the design decisions behind it, and how the components interact.

## System Overview

WebBlackbox is a three-tier core system with an optional collaboration tier:

1. **Recording Tier** — A Chrome extension (or the embeddable `webblackbox` lite SDK) captures events from multiple sources
2. **Processing Tier** — A pipeline chunks, indexes, encrypts and archives events
3. **Playback Tier** — A Player SDK, the React Player UI and the MCP server provide analysis and visualization
4. **Collaboration Tier (optional)** — `share-server` stores uploaded archives and emits redacted secondary indexes for share links

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RECORDING TIER                              │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ Injected │→ │ Content  │→ │  Service   │← │   CDP Router     │ │
│  │  Script  │  │  Script  │  │  Worker    │  │ (chrome.debugger) │ │
│  └──────────┘  └──────────┘  └─────┬──────┘  └──────────────────┘ │
│                                    │                                │
│                              ┌─────▼──────┐                        │
│                              │  Recorder  │                        │
│                              │ (normalize │                        │
│                              │  + buffer) │                        │
│                              └─────┬──────┘                        │
└────────────────────────────────────┼────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────┐
│                        PROCESSING TIER                              │
│                                                                     │
│  ┌───────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │  Chunker  │→ │  Codec  │→ │ Indexer   │→ │ Archive Exporter │  │
│  └───────────┘  └─────────┘  └──────────┘  └────────┬─────────┘  │
│                                                      │             │
│  ┌────────────────────────────┐                      │             │
│  │  Blob Storage (SHA-256    │                      │             │
│  │  dedup, ref counting)     │──────────────────────┘             │
│  └────────────────────────────┘                                    │
└──────────────────────────────────────────┬─────────────────────────┘
                                           │
                                    .webblackbox
                                     ZIP archive
                                           │
┌──────────────────────────────────────────▼─────────────────────────┐
│                         PLAYBACK TIER                               │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    Player SDK                              │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │    │
│  │  │  Query   │ │ Network  │ │   DOM    │ │    Code     │  │    │
│  │  │  Engine  │ │ Waterfall│ │  Differ  │ │  Generator  │  │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────────┘  │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                 Player UI (React + Vite)                   │    │
│  │  Stage/Timeline │ Activity │ Network │ Console │ Realtime  │    │
│  │  Storage │ Tabs │ Perf │ Compare │ Inspector │ Generate    │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Design Principles

### 1. Protocol-First

All data flows through the `@webblackbox/protocol` package. Every event, message, and configuration has a corresponding TypeScript type and Zod validation schema. This ensures:

- **Type safety** across all packages at compile time
- **Runtime validation** at system boundaries
- **Forward compatibility** via the `v: 1` protocol version field
- **Strict schemas** prevent accidental data corruption

### 2. Event Sourcing

WebBlackbox uses an event-sourced architecture. All state changes are captured as immutable events with monotonic timestamps. The ring buffer and archive are append-only event logs that can be replayed to reconstruct session state at any point in time.

### 3. Content-Addressable Storage

Binary data (screenshots, DOM snapshots, response bodies) is stored as blobs identified by SHA-256 hashes. This provides:

- **Automatic deduplication** — Identical content is stored once
- **Integrity verification** — Hashes are checked on read
- **Reference counting** — Blobs are cleaned up when no longer referenced

### 4. Privacy by Default

Sensitive data is redacted before it enters the pipeline:

- Headers like `Authorization`, `Cookie`, and `Set-Cookie` are scrubbed
- Values of body keys matching patterns like `password`, `token`, `secret` are masked (JSON, form, query, XML, text; base64 textual bodies are decoded first)
- URL-valued headers lose their query/fragment; credential-like header names are masked
- DOM elements matching CSS selectors like `input[type='password']` are blocked
- Optional HMAC-SHA-256 hashing with a per-session, never-exported key preserves correlation within a session without exposing raw values

### Recording Profiles

The extension resolves a recording profile before it builds the recorder config:

- **Storage**: `chrome.storage.local["webblackbox.profiles"]` (schema v2, Zod-validated row by row). Profiles are the only source of recording settings. A one-time migration at service worker start (`shared/settings-migration.ts`, version in `webblackbox.settingsVersion`) folds an older version's v1 `webblackbox.options` record into an editable `Default` profile that reproduces its config, moves its performance budget to `webblackbox.performanceBudget` and removes it (version 1). Version 2 (`shared/profiles/preset-migration.ts`) moves the store to the two built-in profiles: references to the removed presets (`builtin:full`, `builtin:qa`, `builtin:full-capture`) and a `Default` profile still equal to the old defaults point at `builtin:maximum`, including the default selection; a customised `Default` is kept as a user profile named `Default (custom)`; a user profile chosen as the default stays the default. Imported profile files and managed rules are mapped the same way. Without a store, `Maximum` records. The options page's General form edits a kept `Default` profile's sampling, freeze-on-error and redaction lists; without one those fields are hidden and a note points to the profiles. The read-only built-ins `Maximum` (`builtin:maximum`, the former Full capture plus `visual: "both"`) and `Light` (`builtin:lite`) live in code, with names shown in the UI language; the store lists the ones the user deleted (`removedRecommendedProfileIds`). Managed policy can add read-only, undeletable `managed:*` profiles and rules.
- **Selection**: explicit `profileId` in `ui.start` (scripts and e2e only; the popup sends none) → highest-priority matching site rule (hosts with subdomains/ports, path globs, query, title regex, meta tag, selector presence, incognito) → store default → `Maximum` → first profile left (none: Start is refused and the popup asks for a profile). DOM-derived signals are probed with `chrome.scripting` only when a rule needs them. Title regexes run in a linear-time matcher (`shared/profiles/title-regex.ts`, no backreferences or lookarounds) and path globs in a linear glob matcher, so no rule can stall the service worker.
- **Application**: the profile is rendered through the existing mode boundary into `RecorderConfig` (categories, redaction, unmask selectors, sampling, body MIME/size/URL filters, visual capture), then enterprise caps apply. The chosen profile runs on every host; categories the caps lowered are recorded as `profile.enterpriseCapped`.
- **Navigation**: rules are re-evaluated on URL change, on page load and when the profiles store or the managed policy change (only the latest request runs). While the tab is still loading, a check waits for the page-load one if any enabled rule reads the title, meta tags or selectors, which are not there yet. A session records with one profile: when the effective profile differs from the one it started with (`sw/profile-change.ts`: another profile picked by the rules, the profile deleted or edited, the enterprise policy changed), the service worker writes a `meta.config` with `profileCancel` (reason, trigger, started and next profile) and stops the session. The data stays for export or deletion; the session list carries a notice for the popup and the badge shows `!` until the popup dismisses it. A different rule that picks the same profile with the same settings is no change. Every `meta.config` carries `profile` (id, name, source, rule, enterprise caps), which the Player shows; older archives may carry `downgradedFrom`, which the Player flags.
- **Export**: every export is encrypted with a passphrase of at least 8 characters, whatever the profile. The service worker remembers the passphrase of a successful export until the browser closes (`sw/export-passphrase.ts`: worker memory and `chrome.storage.session`); `ui.export` without a passphrase uses it, `ui.passphrase-status` / `ui.forget-passphrase` report and drop it.

### 5. Separation of Concerns

Each package has a single responsibility:

| Package       | Responsibility                                                    |
| ------------- | ----------------------------------------------------------------- |
| `protocol`    | Data definitions and validation                                   |
| `recorder`    | Event collection and normalization                                |
| `pipeline`    | Event processing and archival                                     |
| `player-sdk`  | Session analysis and code generation                              |
| `cdp-router`  | Chrome DevTools Protocol management, events routed per tab        |
| `webblackbox` | In-page lite capture SDK; the extension reuses its page-side code |

## Recording Architecture

### Capture Modes and Starting a Recording

The extension has two capture engines (`apps/extension/src/shared/mode-profile.ts`):

- **Lite** — page-side signals (content script and page hooks) plus a browser-side network baseline from `chrome.webRequest`. No request/response bodies, no CDP.
- **Full** — the service worker attaches `chrome.debugger` to the tab: CDP network (with capped bodies), navigation, runtime errors, console and screenshots, plus page-side interaction hints.

The profile picks the engine: `ui.start` without a `mode` starts the profile's own (`base`), and a profile that asks for something only Full records (bodies, screenshots, tab video, whole console messages, CDP categories) always starts in Full (`shared/profiles/engine.ts`). The popup has one `Record` button under a "Profile: … · Change" line; the profile choice lives in Options.

Nothing is recorded until the user presses `Record` in the popup, and only in that tab. Before it starts, Record reloads the page or not according to `shared/start-reload-offer.ts`: `ask` (the default: a dialog with `Reload and Record` as the main choice and a `Don't ask again` box that stores the answer), `always` or `never` (an older stored switch reads as `ask` when on and `never` when off). The reload follows the start, so the recording covers the whole load. The content script either runs in every page from `document_start` (the default) or is injected only into the recorded tab on Start and into its later frames (`shared/content-injection.ts`); the heavy capture agent (`content-agent.js`) is loaded only when recording starts.

### Full → Light Fallback

`sw/capture-fallback.ts` keeps a Full recording going when the debugger cannot run: a page the debugger may not attach to (`shared/capture-fallback.ts#isDebuggerRestrictedUrl`) starts in Lite, and a failed attach or a `chrome.debugger.onDetach` (`canceled_by_user`, `target_closed` while the tab still exists, any other reason) switches the running session to Lite. A closed tab still just stops. The switch cleans up CDP, rebuilds the recorder config for Lite (with the session's capture policy and enterprise caps), reconfigures the recorder, installs the browser-side network baseline and sends the page its Lite status; the tab video, which needs no debugger, goes on. The archive gets `sys.debugger.detach` (Chrome's reason) and a `meta.config` with `captureFallback` (`at`, `reason`, `from`, `to`, `detail`), which `readCaptureFallback` in player-sdk reads into the completeness report, the Player banner and the MCP session summary. The session (and its snapshots) carries `captureFallback`: the badge shows `LITE`, the popup explains it and a notification warns while the popup is closed. A tab video that cannot start no longer fails Start (`sys.notice` code `screen-recording-failed`).

### Event Sources

WebBlackbox captures events from these sources:

#### CDP (Chrome DevTools Protocol, Full mode)

- **Network domain** — HTTP requests, responses, bodies, WebSocket frames, failures
- **Runtime domain** — JavaScript exceptions, console API calls
- **Log domain** — Browser log entries
- **Page domain** — Navigation events, frame lifecycle, screenshots
- **Debugger domain** — Script records and their source map references (see Source Maps)
- Iframes and workers are auto-attached as child sessions. Events are routed by tab, so an event never reaches another tab's recording (`packages/cdp-router`, `apps/extension/src/sw/session-routing.ts`).

#### Browser-side network baseline (Lite mode)

- `chrome.webRequest` request/response metadata for the recorded tab (`apps/extension/src/sw/lite-network-baseline.ts`)

#### Content Script

- **User interactions** — click, dblclick, keydown, input, change, submit, focus, blur, scroll, wheel, sampled pointer moves, pointer targets with dead-click detection, resize, visibilitychange
- **DOM mutations** — Batched MutationObserver records
- **DOM snapshots** — Page snapshots at intervals (top frame)
- **Screenshots** — Lite only: SnapDOM captures on idle, off by default (`screenshotIdleMs: 0`); Full takes screenshots through CDP

In Full mode the content script records DOM mutations and DOM snapshots at the default DOM level (`masked`, recorded through the profile's masking rules like `allow`); it skips them when the profile sets the DOM to `wireframe` or `off`, and skips storage snapshots unless the profile records page storage.

#### Injected Script

Installed in the page's MAIN world with `chrome.scripting.executeScript`. The extension never installs its fetch/XHR hooks: network data comes from `webRequest` (Lite) or CDP (Full).

- **Console** — Intercepts `console.log/warn/error/etc.` calls (Lite)
- **Errors** — Page/runtime errors and unhandled rejections (Lite)
- **Storage** — Monitors localStorage, sessionStorage, and IndexedDB operations (Lite; in Full only when the profile records page storage)

#### Other tabs of the recorded site

With the tabs context on (`metadata` by default, `allow` adds paths and titles), the service worker tracks other same-origin and same-site tabs through `chrome.tabs` and records `meta.tabs.snapshot` and `meta.tabs.change` events (`apps/extension/src/sw/tabs-context/`).

### Event Normalization

Raw events from all sources are normalized by the `DefaultEventNormalizer` into a consistent `WebBlackboxEvent` format. This unified representation enables downstream processing to be source-agnostic.

### Body Completeness (Full Mode)

When the profile asks for bodies, every finished request either gets its body in the archive or a `network.body.skipped` event with a reason: `mime-not-allowed`, `filtered`, `too-large`, `session-limit`, `backlog`, `not-retained`, `started-before-capture`, `unavailable`, `fetch-failed` or `empty` (`BODY_SKIP_REASONS` in `packages/protocol/src/constants.ts`). Request bodies that are not kept are flagged with `postDataSkipped` on `network.request`. Bodies are read 4 at a time, and a session keeps at most 20,000 bodies and 512 MB (`apps/extension/src/sw/full-body-capture.ts`).

### Source Maps

Full mode records scripts with their source map references by default (`metadata`), Lite records none; a profile can set `off`, `metadata` or `embed` (maps embedded at record time, 8 MB per map by default) (`apps/extension/src/shared/profiles/resolve.ts`, `apps/extension/src/sw/source-maps.ts`). The Player SDK, the Player and the MCP server use them to symbolicate minified stack traces.

### Ring Buffer

The recorder can keep the most recent events in a time-windowed ring buffer (`ringBufferMinutes`, default: 10 minutes) for hosts that want an in-memory snapshot (`snapshotRingBuffer()`). When the buffer exceeds its time window, the oldest events are pruned. The ring buffer never limits what is recorded: every event still goes to the pipeline. The extension sets `ringBufferMinutes: 0` (no buffer), because the pipeline already persists every event and nothing reads an in-memory copy.

### Action Span Tracking

User actions (clicks, form submissions, navigation) create "action spans" — time windows (default: 1500ms) that group related events. Network requests initiated during an action span are linked via `ref.act`, enabling cause-effect analysis in the player.

### Freeze Policy

The recorder evaluates freeze conditions on every event:

- **Error freeze** — Uncaught JavaScript exceptions or unhandled promise rejections
- **Network freeze** — 3 failed requests within 10 seconds
- **Performance freeze** — Long tasks of 200ms or more
- **Marker freeze** — User-triggered markers (Ctrl/Cmd+Shift+M), reason `marker`

When a freeze is triggered, it is a notification (`onFreeze` / `freezeReason`): the recorder keeps recording and nothing is trimmed or preserved because of it. The extension turns it into an incident alert (an ERR badge on the toolbar icon, the page indicator and an incident line in the popup) and keeps the network and performance triggers off in both modes (`applyModeProductBoundary` in `apps/extension/src/shared/mode-profile.ts`); the marker freeze is always on, and the error freeze is on by default (`freezeOnError`, which the options and profiles can turn off).

## Processing Architecture

### Chunking

Events are grouped into size-bounded chunks (default: 512KB). Each chunk is:

1. Serialized as NDJSON (newline-delimited JSON)
2. Encoded with the pipeline's chunk codec: `none` is the default, while the extension and the lite SDK select `gzip` (a chunk falls back to `none` when the runtime lacks `CompressionStream`, and the ZIP itself is written with `STORE`); `br` and `zst` are also available
3. Hashed with SHA-256 for integrity
4. Stored with metadata (timestamps, event count, byte length)

Events inside a chunk stay in arrival order, which is **not** `mono` order: page-side events (mouse, resize, storage) reach the recorder later than CDP events from the same moment, so they can also land in a later chunk. Chunk metadata therefore records the min/max `t` and `mono` of the chunk's events, so the time index stays correct when chunks overlap. Archives exported before this change recorded the first/last event instead.

### Indexing

Three indexes are built for efficient querying:

1. **Time Index** — Maps timestamp ranges to chunks, so a time-range query decodes only the chunks that overlap it
2. **Request Index** — Maps network request IDs to event IDs for request tracing
3. **Inverted Index** — Maps searchable terms to event IDs for full-text search

In the extension pipeline, chunks are persisted first (gzip-compressed) and indexes are rebuilt on demand during `finalizeIndexes()` / export. This avoids keeping full-session request and inverted indexes resident in offscreen memory during long-running recordings. The inverted index leaves out terms found in more than half the events of a large session and caps its total postings; a term missing from the index means a full scan for readers.

### Export

The export streams the archive (`exportArchive`): chunks are selected newest first from their metadata and decoded one at a time, blob sizes come from the `blobRefs` store (one row per `[sid, hash]`), the exact archive size is computed before writing, and chunks, indexes and blobs are then encrypted and written one by one into a STORE ZIP. The offscreen document collects the stream into a `Blob` and downloads it.

### Blob Storage

Binary content is stored as content-addressable blobs:

```
Event: screen.screenshot { shotId: "abc", ... }
  → Blob: sha256("...") = "7f83b1657ff1..."
  → Storage: blobs/sha256-7f83b1657ff1....webp
```

Blobs are deduplicated by hash and reference-counted. `MemoryPipelineStorage` keeps them in Maps; the extension's offscreen document uses `IndexedDbPipelineStorage` wrapped in `EncryptedPipelineStorage`, which seals every record with AES-GCM.

### Archive Export

The export process creates a `.webblackbox` ZIP file:

1. All chunks are collected from storage
2. Indexes are finalized
3. Blobs are included
4. Manifest is generated with metadata and stats
5. Integrity hashes are computed for all files
6. AES-GCM encryption is applied to every file but the plaintext envelope `manifest.json` (format version and encryption parameters) and `integrity/hashes.json` (hashes of the encrypted files); the full manifest is written encrypted to `meta/manifest.json`. A passphrase of at least 8 characters is required: there is no plaintext export
7. Everything is packaged into a ZIP archive

This is archive format 2 (`ARCHIVE_FORMAT_VERSION` in `packages/protocol/src/archive-encryption.ts`). Format 1 archives, with the full manifest in a readable `manifest.json`, can still be opened.

## Playback Architecture

### Archive Loading

1. ZIP is extracted
2. The envelope manifest is parsed; with a passphrase, the encrypted full manifest (`meta/manifest.json`) is decrypted and merged (format 1 archives keep the full manifest in `manifest.json`)
3. Encryption metadata is extracted
4. Chunks are decrypted (if needed) and decoded
5. Indexes are loaded
6. Blobs are kept in the archive for on-demand retrieval

### Query Engine

The Player SDK always exposes events in timeline order: `mono`, then wall-clock `t`, then event id (`compareEventsForTimeline`). Each chunk is sorted once when it is parsed. Full loads and ranged queries merge the per-chunk ordered lists, so a query never re-sorts. Ranged queries before a full load pick chunks by their time-index bounds, widened by the true bounds of chunks already parsed. On archives with legacy first/last bounds, such a query can miss a late event near a chunk edge until that chunk has been parsed or all events are loaded.

The query API filters events by:

- **Time range** — Monotonic timestamp start/end
- **Event types** — Array of specific types
- **Levels** — debug, info, warn, error
- **Text** — Full-text search using the inverted index
- **Request ID** — Network request correlation

### Analysis Capabilities

| Analysis           | Method                         | Description                            |
| ------------------ | ------------------------------ | -------------------------------------- |
| Network waterfall  | `getNetworkWaterfall()`        | Complete request/response timeline     |
| Realtime streams   | `getRealtimeNetworkTimeline()` | WebSocket and SSE analysis             |
| Storage operations | `getStorageTimeline()`         | All storage operations chronologically |
| DOM diffing        | `getDomDiffTimeline()`         | Changes between DOM snapshots          |
| Performance        | `getPerformanceArtifacts()`    | CPU profiles, heap snapshots, vitals   |
| Action spans       | `buildDerived()`               | User action analysis with stats        |
| Session comparison | `compareWith()`                | Diff two sessions                      |

### Code Generation

The Player SDK can generate executable code from captured data:

- **curl** — Replay any HTTP request from the command line
- **fetch** — Replay any request in JavaScript
- **HAR** — Standard HTTP Archive for tool interop
- **Playwright test** — Automated test script from user actions
- **Playwright mock** — Test script with captured response mocks
- **Bug report** — Markdown-formatted report with context
- **GitHub/Jira issues** — Pre-filled issue templates

## Extension Contexts

The Chrome extension operates across multiple execution contexts with strict message-passing boundaries:

```
Page World          Extension World         Background
┌──────────┐       ┌──────────────┐        ┌──────────────┐
│ Injected │       │   Content    │        │   Service    │
│  Script  │──────→│   Script     │───────→│   Worker     │
│          │       │              │        │              │
│ window.  │       │ chrome.      │        │ CDP Router   │
│ postMsg  │       │ runtime.     │        │ Recorder     │
│ + nonce  │       │ connect/port │        │ webRequest   │
└──────────┘       └──────────────┘        └──────┬───────┘
                                                  │
                                           ┌──────▼───────┐
                                           │  Offscreen   │
                                           │  Document    │
                                           │  (Pipeline,  │
                                           │  tab video)  │
                                           └──────────────┘
```

Each context is a WXT entrypoint in `apps/extension/entrypoints/` (`background`, `content-script`, `content-agent`, `injected`, and the `popup`, `options`, `sessions` and `offscreen` pages), built with WXT's defaults (`apps/extension/wxt.config.ts`) into `apps/extension/.output/chrome-mv3/`: the service worker and the pages share code in `chunks/`, while `content-script.js`, `content-agent.js` and `injected.js`, which run in pages, are self-contained anonymous strict-mode IIFEs, so they declare nothing in the world they run in and cannot create a global by assignment. Each script entrypoint calls its `src/` module's start function from `main()`. `content-agent.js` (the Lite capture agent, with snapdom) is injected by the service worker into a frame's isolated world when that frame starts recording (`content.agent-request`), and hands its API to the content script of that world through a `Symbol.for` global. WXT writes `manifest.json` from the fields in `apps/extension/scripts/lib/extension-build.mjs` (version from `apps/extension/package.json`, `dev` and `store-safe` profiles) and the entrypoints; it declares no content scripts and no web-accessible resources, since the service worker registers or injects `content-script.js` and injects the other two by path (`src/shared/extension-files.ts`).

- **Page World** → Extension: `window.postMessage` (injected → content). The service worker hands the page hooks a per-recording bridge nonce through `chrome.scripting.executeScript`; once it is set, the content side drops messages without it.
- **Extension** → Background: `chrome.runtime.connect` + `port.postMessage` (content → SW). The service worker trusts a port name only when the sender matches it (`apps/extension/src/sw/port-sender.ts`).
- **Background** ↔ Offscreen: the offscreen document opens a `chrome.runtime.connect` port to the service worker for pipeline traffic. The messages are defined once in `apps/extension/src/shared/offscreen-messages.ts` and checked by hand-written guards on the receiving side. Ports carry JSON, so binary data never travels as a typed array: blobs the worker produces (screenshots, bodies, DOM snapshots) go as base64, and tab video chunks are written to the pipeline inside the offscreen document, which sends the worker only their hashes. The service worker sends the at-rest storage key over the same port as a `sw.storage-key` message.
- **CDP**: `chrome.debugger.sendCommand/onEvent` (SW ↔ browser), Full mode only

## Security Considerations

### Data Protection

- Sensitive headers are redacted before entering the pipeline
- Content masking follows each profile's redaction rules (best effort, no guarantee): body keys and value patterns, blocked selectors, header/cookie/query/storage rules, and the optional built-in heuristics; `contentRedaction: false` records content as captured
- Every archive is encrypted with AES-GCM
- In the extension, the contents of the pipeline IndexedDB (chunk and blob bytes, indexes, integrity, full session records) are encrypted with AES-GCM under a per-browser-session key held only in `chrome.storage.session`; the offscreen document imports it non-extractable. A new key (browser or extension restart) makes older sessions unreadable, and the offscreen document deletes them before it uses the storage. Stopped recordings survive service worker restarts: a snapshot in `chrome.storage.session` lets a new worker rebuild them, and they wait for their export (`exportPrompt`: the popup's export step, the `SAVE` badge, a notification opening `sessions.html#export=<sid>` while the popup is closed) until they are exported or deleted; only a profile with a retention time gets a `chrome.alarms` alarm that deletes them. A recording still running when its worker died is kept the same way, marked interrupted (its snapshot is checkpointed while it records, and the offscreen document writes its pipelines' tails when the worker's port drops); its archive records the interruption. See [PRIVACY.md](PRIVACY.md#local-storage).

### Encryption Details

- **Algorithm**: AES-GCM (256-bit key)
- **Key Derivation**: PBKDF2 with SHA-256, 600,000 iterations for new exports (readers take the count from the manifest, so older 120,000-iteration archives still open; counts outside 10,000–10,000,000 are rejected)
- **Salt**: Random 16-byte salt per archive
- **IV**: Random 12-byte IV per file within the archive
- **Scope**: Event chunks, indexes, blobs, the privacy manifest and the full manifest (`meta/manifest.json`); only the envelope `manifest.json` (format version, encryption parameters) and `integrity/hashes.json` stay readable

### Permission Model

- The default (`dev`) build requests `debugger` for CDP access and `<all_urls>` host access, which `webRequest`, `scripting.executeScript`, and the dynamic content script registration need
- The `store-safe` build profile drops `debugger`, `tabs`, `webRequest`, `webNavigation` and persistent host access and uses `activeTab`, so the content script is injected only on Start, and that build has no Full CDP capture and no Lite `webRequest` network baseline, and the other-tabs context cannot read other tabs' addresses and titles
- Users must explicitly grant permissions during installation
