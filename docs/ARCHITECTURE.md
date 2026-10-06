# Architecture

This document describes the high-level architecture of WebBlackbox, the design decisions behind it, and how the components interact.

## System Overview

WebBlackbox is a three-tier core system with an optional collaboration tier:

1. **Recording Tier** — A Chrome extension (or the embeddable `webblackbox` lite SDK) captures events from multiple sources
2. **Processing Tier** — A pipeline chunks, compresses, indexes, and archives events
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

- **Storage**: `chrome.storage.local["webblackbox.profiles"]` (schema v2, Zod-validated row by row). Without it, the v1 `webblackbox.options` record is migrated on read into an editable `Default` profile that reproduces the pre-profile config. Read-only presets (`Lite`, `Full`, `QA`, `Full capture`) live in code; the store lists the ones the user deleted (`removedRecommendedProfileIds`, also covering `Default`). Managed policy can add read-only, undeletable `managed:*` profiles and rules.
- **Selection**: explicit popup choice → highest-priority matching site rule (hosts with subdomains/ports, path globs, query, title regex, meta tag, selector presence, incognito) → store default → first profile left (none: Start is refused and the popup asks for a profile). DOM-derived signals are probed with `chrome.scripting` only when a rule needs them. Title regexes run in a linear-time matcher (`shared/profiles/title-regex.ts`, no backreferences or lookarounds) and path globs in a linear glob matcher, so no rule can stall the service worker.
- **Application**: the profile is rendered through the existing mode boundary into `RecorderConfig` (categories, redaction, unmask selectors, sampling, body MIME/size/URL filters, visual capture), then enterprise caps apply. The chosen profile runs on every host; categories the caps lowered are recorded as `profile.enterpriseCapped`.
- **Navigation**: rules are re-evaluated on URL change, on page load and when the profiles store, the v1 options or the managed policy change (only the latest request runs). While the tab is still loading, a check waits for the page-load one if any enabled rule reads the title, meta tags or selectors, which are not there yet. A session records with one profile: when the effective profile differs from the one it started with (`sw/profile-change.ts`: another profile picked by the rules, the profile deleted or edited, the enterprise policy changed), the service worker writes a `meta.config` with `profileCancel` (reason, trigger, started and next profile) and stops the session. The data stays for export or deletion; the session list carries a notice for the popup and the badge shows `!` until the popup dismisses it. A different rule that picks the same profile with the same settings is no change. Every `meta.config` carries `profile` (id, name, source, rule, enterprise caps), which the Player shows; older archives may carry `downgradedFrom`, which the Player flags.
- **Export**: every export is encrypted with a passphrase of at least 8 characters, whatever the profile.

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

A profile that asks for something only Full records (bodies, screenshots, tab video, whole console messages, CDP categories) locks the engine to Full in the popup (`shared/profiles/engine.ts`).

Nothing is recorded until the user presses Start in the popup, and only in that tab. Start can offer to reload the page first so the recording covers the whole load (`shared/start-reload-offer.ts`, on by default). The content script either runs in every page from `document_start` (the default) or is injected only into the recorded tab on Start and into its later frames (`shared/content-injection.ts`); the heavy capture agent (`content-agent.js`) is loaded only when recording starts.

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

In Full mode the content script skips DOM mutations and DOM/storage snapshots unless the profile records the raw DOM or page storage.

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

Events are stored in a time-windowed ring buffer (default: 10 minutes). When the buffer exceeds its time window, the oldest events are automatically pruned. This keeps memory usage bounded while always preserving recent context.

### Action Span Tracking

User actions (clicks, form submissions, navigation) create "action spans" — time windows (default: 1500ms) that group related events. Network requests initiated during an action span are linked via `ref.act`, enabling cause-effect analysis in the player.

### Freeze Policy

The recorder evaluates freeze conditions on every event:

- **Error freeze** — Uncaught JavaScript exceptions or unhandled promise rejections
- **Network freeze** — 3 failed requests within 10 seconds
- **Performance freeze** — Long tasks of 200ms or more
- **Manual freeze** — User-triggered markers (Ctrl+Shift+M)

When a freeze is triggered, the ring buffer contents are preserved, providing full context around the issue. The extension turns the network and performance freezes off in both modes (`applyModeProductBoundary` in `apps/extension/src/shared/mode-profile.ts`); error and marker freezes stay on.

## Processing Architecture

### Chunking

Events are grouped into size-bounded chunks (default: 512KB). Each chunk is:

1. Serialized as NDJSON (newline-delimited JSON)
2. Encoded with chunk codecs (`none`, `gzip`, `br`, `zst`)
3. Hashed with SHA-256 for integrity
4. Stored with metadata (timestamps, event count, byte length)

Events inside a chunk stay in arrival order, which is **not** `mono` order: page-side events (mouse, resize, storage) reach the recorder later than CDP events from the same moment, so they can also land in a later chunk. Chunk metadata therefore records the min/max `t` and `mono` of the chunk's events, so the time index stays correct when chunks overlap. Archives exported before this change recorded the first/last event instead.

### Indexing

Three indexes are built for efficient querying:

1. **Time Index** — Maps timestamp ranges to chunks for O(log n) time-based lookup
2. **Request Index** — Maps network request IDs to event IDs for request tracing
3. **Inverted Index** — Maps searchable terms to event IDs for full-text search

In the extension pipeline, chunks are persisted first and indexes are rebuilt on demand during `finalizeIndexes()` / export. This avoids keeping full-session request and inverted indexes resident in offscreen memory during long-running recordings.

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

Each context is its own tsup entry (`sw`, `content`, `content-agent`, `offscreen`, `injected`, `popup`, `options`, `sessions` in `apps/extension/tsup.config.ts`), bundled into `apps/extension/build/`. `manifest.json` is generated in code by `apps/extension/scripts/lib/extension-build.mjs` (version from `apps/extension/package.json`, `dev` and `store-safe` profiles); it declares no content scripts, since the service worker registers or injects `content.js` itself.

- **Page World** → Extension: `window.postMessage` (injected → content). The service worker hands the page hooks a per-recording bridge nonce through `chrome.scripting.executeScript`; once it is set, the content side drops messages without it.
- **Extension** → Background: `chrome.runtime.connect` + `port.postMessage` (content → SW). The service worker trusts a port name only when the sender matches it (`apps/extension/src/sw/port-sender.ts`).
- **Background** ↔ Offscreen: the offscreen document opens a `chrome.runtime.connect` port to the service worker for pipeline traffic; the service worker sends the at-rest storage key over the same port as a `sw.storage-key` message.
- **CDP**: `chrome.debugger.sendCommand/onEvent` (SW ↔ browser), Full mode only

## Security Considerations

### Data Protection

- Sensitive headers are redacted before entering the pipeline
- Content masking follows each profile's redaction rules (best effort, no guarantee): body keys and value patterns, blocked selectors, header/cookie/query/storage rules, and the optional built-in heuristics; `contentRedaction: false` records content as captured
- Every archive is encrypted with AES-GCM
- In the extension, everything in the pipeline IndexedDB (chunks, blobs, indexes, integrity, session metadata) is encrypted with AES-GCM under a per-browser-session key held only in `chrome.storage.session`; the offscreen document imports it non-extractable. A new key (browser or extension restart) deletes the database. Stopped recordings survive service worker restarts: a snapshot in `chrome.storage.session` lets a new worker rebuild them, and a `chrome.alarms` alarm deletes them when their retention ends. See [PRIVACY.md](PRIVACY.md#local-storage).

### Encryption Details

- **Algorithm**: AES-GCM (256-bit key)
- **Key Derivation**: PBKDF2 with SHA-256, 600,000 iterations for new exports (readers take the count from the manifest, so older 120,000-iteration archives still open; counts outside 10,000–10,000,000 are rejected)
- **Salt**: Random 16-byte salt per archive
- **IV**: Random 12-byte IV per file within the archive
- **Scope**: Event chunks, indexes, blobs, the privacy manifest and the full manifest (`meta/manifest.json`); only the envelope `manifest.json` (format version, encryption parameters) and `integrity/hashes.json` stay readable

### Permission Model

- The default (`dev`) build requests `debugger` for CDP access and `<all_urls>` host access, which `webRequest`, `scripting.executeScript`, the dynamic content script registration and `captureVisibleTab` need
- The `store-safe` build profile drops `debugger` and persistent host access and uses `activeTab`, so the content script is injected only on Start
- Users must explicitly grant permissions during installation
