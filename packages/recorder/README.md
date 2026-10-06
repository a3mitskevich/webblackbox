<p align="center">
  <a href="https://github.com/webllm/webblackbox"><img src="https://raw.githubusercontent.com/webllm/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/recorder</h1>

<p align="center">
  Event recording engine with normalization, ring buffer, redaction, and plugin system.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@webblackbox/recorder"><img src="https://img.shields.io/npm/v/@webblackbox/recorder.svg?color=f97316" alt="npm version" /></a>
  <a href="https://github.com/webllm/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@webblackbox/recorder?color=374151" alt="License" /></a>
  <a href="https://github.com/webllm/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

The event recording engine for WebBlackbox. Collects raw events from multiple sources (Chrome DevTools Protocol, content scripts, system), normalizes them into the unified `WebBlackboxEvent` format, and manages a time-windowed ring buffer for memory-efficient session recording.

## Overview

- **WebBlackboxRecorder** — Main entry point for ingesting and processing raw events
- **EventRingBuffer** — Time-windowed circular buffer with configurable duration
- **DefaultEventNormalizer** — Maps CDP and content script events to normalized payloads
- **ActionSpanTracker** — Links related events within user action time windows
- **FreezePolicy** — Evaluates auto-freeze conditions (errors, network failures, long tasks)
- **Redaction** — Privacy-preserving payload scrubbing with pattern matching and hashing
- **Plugin System** — Extensible event processing pipeline

## Usage

### Basic Recording

```typescript
import { WebBlackboxRecorder } from "@webblackbox/recorder";
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";

const recorder = new WebBlackboxRecorder(DEFAULT_RECORDER_CONFIG, {
  onEvent: (event) => {
    // Forward normalized events to pipeline
    pipeline.ingest(event);
  },
  onFreeze: (reason, event) => {
    // Handle freeze (e.g., export ring buffer)
    console.log(`Session frozen: ${reason}`);
  }
});

// Ingest raw events from various sources
const result = recorder.ingest({
  source: "cdp",
  rawType: "Network.requestWillBeSent",
  tabId: 123,
  sid: "S-1706000000000-abc",
  t: Date.now(),
  mono: performance.now(),
  payload: {/* CDP event params */}
});

if (result.event) {
  console.log("Normalized event:", result.event.type);
}

if (result.freezeReason) {
  console.log("Freeze triggered:", result.freezeReason);
}
```

### Ring Buffer

```typescript
// Snapshot all buffered events
const events = recorder.snapshotRingBuffer();

// Get count of buffered events
const count = recorder.getBufferedEventCount();

// Clear the ring buffer
recorder.clearRingBuffer();
```

### Using the Ring Buffer Directly

```typescript
import { EventRingBuffer } from "@webblackbox/recorder";

const buffer = new EventRingBuffer(10); // 10-minute window

buffer.push(event);
const snapshot = buffer.snapshot(); // Returns events within the window
const size = buffer.size();
buffer.clear();
```

## Event Normalization

The `DefaultEventNormalizer` handles mapping from raw source events to `WebBlackboxEvent` types:

### CDP Events

| CDP Method                                                      | WebBlackbox Event     |
| --------------------------------------------------------------- | --------------------- |
| `Network.requestWillBeSent`                                     | `network.request`     |
| `Network.responseReceived`                                      | `network.response`    |
| `Network.loadingFinished`                                       | `network.finished`    |
| `Network.loadingFailed`                                         | `network.failed`      |
| `Network.webSocketCreated`                                      | `network.ws.open`     |
| `Network.webSocketFrameReceived` / `Network.webSocketFrameSent` | `network.ws.frame`    |
| `Network.webSocketClosed`                                       | `network.ws.close`    |
| `Network.eventSourceMessageReceived`                            | `network.sse.message` |
| `Runtime.exceptionThrown`                                       | `error.exception`     |
| `Runtime.consoleAPICalled`                                      | `console.entry`       |
| `Log.entryAdded`                                                | `console.entry`       |
| `Page.frameNavigated`                                           | `nav.commit`          |
| `Page.navigatedWithinDocument`                                  | `nav.hash`            |

CDP `Network.*` payloads pass through a field allowlist: ids, timing, sanitized URLs, method, status, MIME type, sizes, normalized headers and the initiator type. Everything else — raw header text, security details, initiator stacks, base64 `postDataEntries`, WebSocket `payloadData` — is dropped.

`Network.requestServedFromCache` has no event of its own. The normalizer remembers it per CDP session (at most 2048 open requests) and marks the request's response (`response.fromMemoryCache: true`, unless it is a disk-cache hit) and its finish (`fromMemoryCache: true`), so a memory-cache hit — also one Chrome finishes without `responseReceived` — closes as "from cache". Chrome sends it for memory-cache and `data:` URL hits; the `-1` `encodedDataLength` it reports for `blob:` URLs is dropped.

Under `capturePolicy.categories.console === "allow"` console entries keep their text in full: up to 64 KiB per entry for the text and for all arguments together, with `truncated: true` when that ceiling is hit. `console.error` / `warn` / `assert` / `trace` and `Log.entryAdded` errors and warnings also carry the whole call stack as V8 `Error.stack` text in `stack` (`    at fn (url:line:col)`, 1-based, up to 200 frames), which stack parsers and source-map symbolication read like a page error stack; `stackTop` (`fn @ url:line:col`, 0-based) stays. Other console policies keep the short previews (260/320/600 characters, top frame only).

`Runtime.exceptionThrown` is projected onto the page-hook `pageError` shape: `message`, `name`, `stack`, sanitized `filename`, 1-based `lineno`/`colno`, `rejection: true` for unhandled promise rejections, `exceptionId` and `timestamp`; remote object handles and previews are dropped. Messages are capped at 2,000 characters and stacks at 32 frames / 8,000 characters; under `console: "allow"` the whole message is kept and, when CDP reports more call frames than `Error.stack` (V8 cuts it at 10), the stack is rebuilt from every CDP frame (up to 200). Under `capturePolicy.categories.console === "metadata"` every `error.exception` / `error.unhandledrejection` keeps only that metadata, marked `messageRedacted`/`stackRedacted` (or `reasonRedacted`), exactly like lite mode.

### Content Script Events

| Raw Type                                             | WebBlackbox Event                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `click` / `dblclick`                                 | `user.click` / `user.dblclick`                                    |
| `keydown`                                            | `user.keydown`                                                    |
| `input`                                              | `user.input`                                                      |
| `submit`                                             | `user.submit`                                                     |
| `scroll`                                             | `user.scroll`                                                     |
| `mousemove`                                          | `user.mousemove`                                                  |
| `focus` / `blur`                                     | `user.focus` / `user.blur`                                        |
| `resize`                                             | `user.resize`                                                     |
| `marker`                                             | `user.marker`                                                     |
| `visibilitychange`                                   | `user.visibility`                                                 |
| `mutation`                                           | `dom.mutation.batch`                                              |
| `snapshot`                                           | `dom.snapshot`                                                    |
| `screenshot`                                         | `screen.screenshot`                                               |
| `console`                                            | `console.entry`                                                   |
| `fetch` / `xhr`                                      | `network.request` / `network.response`                            |
| `fetchError`                                         | `network.failed`                                                  |
| `pageError` / `unhandledrejection` / `resourceError` | `error.exception` / `error.unhandledrejection` / `error.resource` |
| `localStorageOp` / `localStorageSnapshot`            | `storage.local.op` / `storage.local.snapshot`                     |
| `sessionStorageOp`                                   | `storage.session.op`                                              |
| `indexedDbOp` / `indexedDbSnapshot`                  | `storage.idb.op` / `storage.idb.snapshot`                         |
| `cookieSnapshot`                                     | `storage.cookie.snapshot`                                         |
| `longtask` / `vitals`                                | `perf.longtask` / `perf.vitals`                                   |

`dom.rrweb.event` is emitted when raw `rrweb` payloads are ingested (for example, lite mutation-summary events produced by the webblackbox capture agent).

## Action Span Tracking

The `ActionSpanTracker` groups related events into action spans:

```typescript
import { ActionSpanTracker } from "@webblackbox/recorder";

const tracker = new ActionSpanTracker(1500); // 1500ms action window

// Track user actions (click, submit, marker, nav)
// Related events within the time window are linked via ref.act
```

Action types: `click`, `submit`, `marker`, `nav`

Events within the action window receive a `ref.act` reference linking them to the action span. Network requests initiated during an action are also tracked.

## Freeze Policy

The `FreezePolicy` evaluates conditions that should pause recording:

```typescript
import { FreezePolicy } from "@webblackbox/recorder";

const policy = new FreezePolicy({
  freezeOnError: true,
  freezeOnNetworkFailure: true,
  freezeOnLongTaskSpike: true
});

const reason = policy.evaluate(event);
// Returns: "error" | "network" | "marker" | "perf" | null
```

Freeze conditions:

- **Error** — Uncaught exceptions or unhandled rejections (`error.resource` is recorded but does not auto-freeze)
- **Network failure** — Network request failures exceeding threshold (emits freeze reason `"network"`)
- **Performance** — Long tasks exceeding 200ms
- **Marker** — User-triggered markers

## Redaction

```typescript
import { createRedactionHashKey, redactPayload } from "@webblackbox/recorder";

// One key per session, kept in memory only (never export it with the archive).
const hashKey = createRedactionHashKey();

const redacted = redactPayload(
  payload,
  {
    redactHeaders: ["authorization", "cookie", "set-cookie"],
    redactCookieNames: ["token", "session"],
    redactBodyPatterns: ["password", "secret"],
    blockedSelectors: [".secret", "input[type='password']"],
    hashSensitiveValues: true // keyed HMAC-SHA-256 hash instead of [REDACTED]
  },
  { hashKey }
);
```

`WebBlackboxRecorder` creates its own per-session key; without `hashKey`, `redactPayload` falls back to a random key shared by the current JS realm.

Redaction is applied recursively through nested objects and supports:

- HTTP header value masking by header name, including unlisted credential-like names (e.g. `X-Access-Token`)
- Query/fragment stripping for URL-valued headers (`Location`, `Referer`, `:path`, …) and URL fields
- Cookie value masking by cookie name
- Payload key and string masking by body pattern
- DOM element masking by CSS selector
- Optional HMAC-SHA-256 hashing (per-session key) for value correlation within a session

Network body blobs are redacted separately with `redactBodyText` / `redactBodyBytes` from `@webblackbox/protocol`, which mask the values of sensitive keys in JSON, form, query, XML and `key: value` text.

Inline bodies — textual request bodies (`network.request` → `request.postData`), WebSocket text frames (`network.ws.frame` → `frame.payloadPreview`) and SSE messages (`network.sse.message` → `data`) — follow the same rule as `network.body`. They are kept only when `capturePolicy.categories.network` is `"body-allowlist"`, value-masked with `redactBodyText` and size-capped: request bodies at 64 KiB; WebSocket frames and SSE messages at the profile body size (`sampling.bodyCaptureMaxBytes`, in UTF-8 bytes, cut on a character boundary), or at the old 512 / 800-character previews when it is 0. A cut sets `postDataTruncated`, `frame.payloadTruncated` or `dataTruncated`. The pipeline later moves frame and message text over 16 KiB into a blob (`frame.payloadHash` / `dataHash`, with a 512-character head left inline). Otherwise only sizes survive (`postDataSize`, `frame.payloadLength`/`opcode`, SSE `dataSize`). A host can add its own gate through the `shouldKeepInlineNetworkBody` recorder hook (it gets the event type, the unsanitized request URL and the request MIME type); the extension uses it to apply its site body-capture rules to request bodies, the same rules response bodies follow.

## Plugins

Extend the recorder with custom plugins:

```typescript
import type { RecorderPlugin, RecorderPluginContext } from "@webblackbox/recorder";

const myPlugin: RecorderPlugin = {
  name: "my-plugin",

  onRawEvent(raw, ctx: RecorderPluginContext) {
    // Process raw events before normalization
    // Return modified raw event or null to drop
    return raw;
  },

  onEvent(event, ctx: RecorderPluginContext) {
    // Process normalized events after recording
    // Can annotate, transform, or filter events
    return event;
  }
};

const recorder = new WebBlackboxRecorder(config, hooks, normalizer, [myPlugin]);
```

### Built-in Plugins

```typescript
import {
  createRouteContextPlugin,
  createErrorFingerprintPlugin,
  createAiRootCausePlugin,
  createDefaultRecorderPlugins
} from "@webblackbox/recorder";

// Route context tracking per stream
const routePlugin = createRouteContextPlugin();

// Error fingerprint generation
const errorPlugin = createErrorFingerprintPlugin();

// AI-assisted root cause analysis
const aiPlugin = createAiRootCausePlugin(5000); // 5s analysis window

// Bundle of all default plugins
const plugins = createDefaultRecorderPlugins();
```

## License

[MIT](https://github.com/webllm/webblackbox/blob/main/LICENSE)
