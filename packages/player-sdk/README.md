<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://raw.githubusercontent.com/a3mitskevich/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/player-sdk</h1>

<p align="center">
  Session playback, querying, analysis, and code generation SDK.
</p>

<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-374151" alt="License" /></a>
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

The session playback and analysis SDK for WebBlackbox. Opens `.webblackbox` archives and provides rich querying, analysis, and code generation capabilities.

## Overview

- **WebBlackboxPlayer** — Main player class for loading and analyzing sessions
- **Lazy Chunk Decode** — Events are decoded on demand per chunk with LRU cache eviction
- **Event Querying** — Filter events by type, level, time range, text, and request ID
- **Network Analysis** — Waterfall visualization, realtime stream timeline, request detail extraction
- **Storage Analysis** — Timeline of cookie, localStorage, IndexedDB, and cache operations
- **DOM Analysis** — Snapshot diffing to track added, removed, and changed elements
- **Performance Analysis** — Web Vitals, long tasks, CPU profiles, heap snapshots, traces
- **Stack Symbolication** — Map minified stack traces to original sources with source maps embedded in the archive, `.map` files, or a symbol server
- **Tabs Context** — The other tabs of the recorded site that were open in parallel
- **Session Comparison** — Compare two sessions by event counts, error rates, and request patterns
- **Code Generation** — Generate curl, fetch, HAR, Playwright scripts, bug reports, and issue templates

## Installation

This fork does not publish to npm: `@webblackbox/player-sdk` on npm is the upstream package, without this fork's changes (it cannot read format-2 archives). Use it from the workspace and build it from source:

```bash
pnpm install
pnpm --filter @webblackbox/player-sdk build   # → packages/player-sdk/dist
```

Inside the monorepo, depend on it with `"@webblackbox/player-sdk": "workspace:*"`.

## Usage

### Opening an Archive

```typescript
import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

// From ArrayBuffer, Uint8Array, or Blob
const player = await WebBlackboxPlayer.open(archiveBytes);

// With encryption passphrase
const player = await WebBlackboxPlayer.open(archiveBytes, {
  passphrase: "my-secret"
});

// Preload only a monotonic time window (loads intersecting chunks only)
const scopedPlayer = await WebBlackboxPlayer.open(archiveBytes, {
  range: { monoStart: 12000, monoEnd: 45000 }
});

console.log(player.status); // "loaded"
console.log(player.archive.manifest); // ExportManifest
console.log(player.events.length); // Total event count
```

### Archive Formats

`open()` reads both archive formats:

- **Format 2** (every current export; `protocolVersion: 2`): `manifest.json` is a plaintext envelope with only the
  protocol version and the encryption parameters. The full manifest is the encrypted `meta/manifest.json`, so
  nothing but the envelope opens without the passphrase.
- **Format 1** (`protocolVersion: 1`, older archives): the full manifest is `manifest.json` itself, and the
  archive may be plaintext.

Encrypted files use AES-GCM with a PBKDF2-SHA-256 key derived from the passphrase. The passphrase is used trimmed
(an untrimmed one is tried too, for older archives). Integrity hashes and decryption use the Web Crypto API, so in a
browser the page must be a secure context (`https://` or `localhost`); on Node the SDK falls back to `node:crypto`
for hashing.

### Opening Untrusted Archives

`open()` treats every archive as untrusted input:

- `manifest.json`, `integrity/hashes.json`, the indexes and the privacy manifest are validated against the
  `@webblackbox/protocol` Zod schemas, `manifest.json` is checked against its integrity hash, and a
  `protocolVersion` other than 1 or 2 is rejected.
- The ZIP central directory is checked before anything is inflated, and every entry is inflated with a
  byte counter that stops at its declared size, so zip bombs fail fast with an `ArchiveLimitError`.
- Event chunks are decoded (gzip / br / zst) with per-chunk and total output caps.
- PBKDF2 iteration counts outside 10,000–10,000,000 are rejected before a key is derived.

The defaults (`DEFAULT_ARCHIVE_LOAD_LIMITS`) are 100,000 entries, 256 MiB per entry or decoded chunk, and
1 GiB in total. Override any of them per call:

```typescript
import { ArchiveLimitError, WebBlackboxPlayer } from "@webblackbox/player-sdk";

try {
  const player = await WebBlackboxPlayer.open(archiveBytes, {
    limits: { maxTotalUncompressedBytes: 256 * 1024 * 1024 }
  });
} catch (error) {
  if (error instanceof ArchiveLimitError) {
    // The archive is larger than allowed; error.message names the entry and the limit.
  }
}
```

### Querying Events

Results are always in timeline order: `mono`, then wall-clock `t`, then event id. Archives store events in arrival order, and the SDK sorts and merges chunks for you. Use `compareEventsForTimeline` to order your own event lists the same way.

```typescript
// Get all events
const allEvents = player.query();

// Filter by type
const networkEvents = player.query({
  types: ["network.request", "network.response"]
});

// Filter by level
const errors = player.query({
  levels: ["error"]
});

// Filter by time range (monotonic timestamps)
const firstMinute = player.query({
  range: { monoStart: 0, monoEnd: 60000 }
});

// Text search within events
const matches = player.query({
  text: "TypeError"
});

// Filter by request ID
const requestEvents = player.query({
  requestId: "R-12345"
});

// Combine filters with pagination
const page = player.query({
  types: ["error.exception"],
  levels: ["error"],
  range: { monoStart: 0, monoEnd: 120000 },
  limit: 50,
  offset: 0
});
```

### Full-Text Search

```typescript
const results = player.search("login failed", 100);
// Returns: PlayerSearchResult[]
// { eventId, score, event }
```

### Blob Retrieval

```typescript
// Get binary blob by hash (screenshots, DOM snapshots, response bodies)
const blob = await player.getBlob("abc123...");
if (blob) {
  console.log(blob.mime); // "image/webp"
  console.log(blob.bytes); // Uint8Array
}
```

## Analysis APIs

### Network Waterfall

```typescript
const waterfall = player.getNetworkWaterfall();

for (const entry of waterfall) {
  console.log(entry.url);
  console.log(entry.method); // "GET", "POST", etc.
  console.log(entry.status); // 200, 404, etc.
  console.log(entry.durationMs); // Request duration
  console.log(entry.mimeType); // Response MIME type
  console.log(entry.failed); // Whether request failed
  console.log(entry.requestHeaders); // Request headers
  console.log(entry.responseHeaders); // Response headers
}

// Filter by time range
const recentNetwork = player.getNetworkWaterfall({
  monoStart: 5000,
  monoEnd: 30000
});
```

### Realtime Network Timeline (WebSocket / SSE)

```typescript
const timeline = player.getRealtimeNetworkTimeline();

for (const entry of timeline) {
  console.log(entry.protocol); // "ws" | "sse"
  console.log(entry.direction); // "sent" | "received" | "unknown"
  console.log(entry.url);
  console.log(entry.payloadPreview);
  console.log(entry.payloadLength);
}
```

### Stack Symbolication

```typescript
import { createArchiveSymbolicator, createSourceMapFileProvider } from "@webblackbox/player-sdk";

// Maps embedded in the archive first, then any extra providers (.map files, a symbol server)
const symbolicator = createArchiveSymbolicator(player, [createSourceMapFileProvider(files)]);
const frames = await symbolicator.symbolicateStack(error.stack);
// [{ frame, status: "mapped" | "no-map" | "no-mapping" | "map-error", original?: { source, line, column } }]
```

### Tabs Context

```typescript
import { getRelatedTabsAt, readTabsContext } from "@webblackbox/player-sdk";

const tabs = readTabsContext(player.query());
console.log(tabs.summary.openAtStart, tabs.summary.maxConcurrent, tabs.summary.distinctTabs);
const openNow = getRelatedTabsAt(tabs, mono); // other tabs of the site open at `mono`
```

### Request Detail

```typescript
// Get all events for a specific request
const reqEvents = player.getRequestEvents("R-12345");
// Returns network.request, network.response, network.finished, etc.
```

### Storage Timeline

```typescript
const storage = player.getStorageTimeline();

for (const entry of storage) {
  console.log(entry.kind); // "cookie" | "local" | "session" | "idb" | "cache" | "sw"
  console.log(entry.operation); // set, delete, clear, etc.
  console.log(entry.eventType); // Full event type
}
```

### DOM Analysis

```typescript
// Get all DOM snapshots
const snapshots = player.getDomSnapshots();

// Compute diff timeline across all snapshots
const diffs = await player.getDomDiffTimeline();

for (const diff of diffs) {
  console.log(diff.summary.added); // Number of added DOM paths
  console.log(diff.summary.removed); // Number of removed DOM paths
  console.log(diff.summary.changed); // Number of changed DOM paths
  console.log(diff.addedPaths); // string[]
  console.log(diff.removedPaths); // string[]
  console.log(diff.changedPaths); // string[]
}

// Compare two specific snapshots
const diff = await player.compareDomSnapshots(prevId, currId);
```

### Performance Artifacts

```typescript
const artifacts = player.getPerformanceArtifacts();

for (const artifact of artifacts) {
  console.log(artifact.kind); // "trace" | "cpu" | "heap" | "longtask" | "vitals"
  console.log(artifact.hash); // Blob hash (if applicable)
  console.log(artifact.size); // Size in bytes
}
```

### Action Span Analysis

```typescript
const derived = player.buildDerived();

for (const span of derived.actionSpans) {
  console.log(span.actId); // Action span ID
  console.log(span.startMono); // Start time
  console.log(span.endMono); // End time
  console.log(span.eventIds); // Related event IDs
  console.log(span.triggerEventId); // Trigger event
  console.log(span.requestCount); // Network requests in span
  console.log(span.errorCount); // Errors in span
}

console.log(derived.totals.events); // Total event count
console.log(derived.totals.errors); // Total error count
console.log(derived.totals.requests); // Total request count

// Timeline view with request/error/screenshot context per action
const timeline = player.getActionTimeline({
  range: { monoStart: 0, monoEnd: 60000 },
  limit: 20
});
```

## Code Generation

### curl / fetch

```typescript
const curl = player.generateCurl("R-12345");
// curl 'https://api.example.com/data' \
//   -X 'POST' \
//   -H 'content-type: application/json' \
//   --data-raw '...' \
//   --compressed

const fetch = player.generateFetch("R-12345");
// await fetch("https://api.example.com/data", { "method": "POST", "headers": {...}, "body": "..." });
```

Recorded values are untrusted, so generated code quotes them: every curl argument is shell-quoted, and fetch and
Playwright code embeds URLs, names and selectors as JSON string literals.

### HAR Export

```typescript
const harJson = player.exportHar();
// Standard HTTP Archive 1.2 format
// Compatible with Chrome DevTools, Charles Proxy, etc.

// Export specific time range
const harPartial = player.exportHar({ monoStart: 0, monoEnd: 30000 });
```

### Tab Video

```typescript
// One segment per recordingId (a restarted recording adds a part), in start order
const [segment] = player.getScreenRecordings();
// { recordingId, part, durationMs, size, mime, chunkCount, missingChunks: [], ... }

// The chunks joined in order; Chrome's live WebM gets a Duration and Cues so players seek
const video = await player.getScreenRecordingBlob(segment.recordingId);
// { bytes, mime: "video/webm;codecs=vp9", durationMs, seekable: true }
// Missing chunks throw ScreenRecordingIncompleteError (error.missing lists each index)
```

### Bug Report

```typescript
const report = player.generateBugReport({
  title: "Login fails with 500 error",
  range: { monoStart: 0, monoEnd: 30000 },
  maxItems: 30
});
// Returns markdown-formatted bug report with session context
```

### Playwright Scripts

```typescript
// Generate test script from recorded user actions
const testScript = player.generatePlaywrightScript({
  name: "checkout flow",
  startUrl: "https://example.com",
  includeHarReplay: true
});

// Generate mock script with captured network responses
const mockScript = await player.generatePlaywrightMockScript({
  name: "checkout flow",
  startUrl: "https://example.com",
  maxMocks: 50
});
```

### Issue Templates

```typescript
// GitHub issue template
const github = player.generateGitHubIssueTemplate({
  title: "Bug title"
});
// { title, body, labels, assignees }

// Jira issue template
const jira = player.generateJiraIssueTemplate({
  title: "Bug title"
});
// { fields: { summary, description, issuetype, labels, project?, priority? } }
```

## Session Comparison

```typescript
const other = await WebBlackboxPlayer.open(otherArchiveBytes);

const comparison = player.compareWith(other);
console.log(comparison.leftSessionId); // Baseline session ID
console.log(comparison.rightSessionId); // Compared session ID
console.log(comparison.eventDelta); // Event count difference
console.log(comparison.errorDelta); // Error count difference
console.log(comparison.requestDelta); // Request count difference
console.log(comparison.durationDeltaMs); // Duration difference

for (const td of comparison.typeDeltas) {
  console.log(`${td.type}: ${td.left} vs ${td.right} (${td.delta})`);
}

for (const row of comparison.endpointRegressions) {
  console.log(`${row.method} ${row.endpoint}`);
  console.log(`failure rate delta: ${row.failureRateDelta}`);
  console.log(`p95 delta(ms): ${row.p95DurationDeltaMs}`);
}

// Storage comparison
const storageDiff = player.compareStorageWith(other);

// DOM comparison (latest snapshots)
const domDiff = await player.compareLatestDomSnapshotWith(other);
```

## Types

```typescript
type PlayerStatus = "idle" | "loaded";

type PlayerOpenInput = ArrayBuffer | Uint8Array | Blob;

type PlayerOpenOptions = {
  passphrase?: string;
  range?: PlayerRange;
  limits?: Partial<ArchiveLoadLimits>; // defaults: DEFAULT_ARCHIVE_LOAD_LIMITS
};

type PlayerQuery = {
  range?: PlayerRange;
  types?: WebBlackboxEventType[];
  levels?: EventLevel[];
  text?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
};

type PlayerRange = {
  monoStart?: number;
  monoEnd?: number;
};

type PlayerSearchResult = {
  eventId: string;
  score: number;
  event: WebBlackboxEvent;
};

type PlayerArchive = {
  manifest: ExportManifest;
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest | null;
};
```

## License

[MIT](https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE)
