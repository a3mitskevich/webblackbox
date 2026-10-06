<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://raw.githubusercontent.com/a3mitskevich/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/pipeline</h1>

<p align="center">
  Chunking, indexing, blob storage, and encrypted archive export pipeline.
</p>

<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-374151" alt="License" /></a>
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

The event processing pipeline for WebBlackbox. Handles chunking, indexing, blob storage, and archive export for recorded sessions.

## Overview

- **FlightRecorderPipeline** — Main pipeline orchestrating the full event processing lifecycle
- **EventChunker** — Groups events into size-bounded chunks with codec support
- **EventIndexer** — Builds time-based, request-based, and inverted text search indexes on demand from stored chunks
- **Codec** — NDJSON chunk codec support for `none` (the default), `gzip`, `br`, and `zst`; a codec the runtime lacks falls back to `none` with a warning
- **Archive Export** — Creates `.webblackbox` ZIP archives, always AES-GCM encrypted (`createWebBlackboxArchive`), and reads them back (`readWebBlackboxArchive`)
- **PipelineStorage** — Abstract storage interface with in-memory (`MemoryPipelineStorage`) and IndexedDB (`IndexedDbPipelineStorage`) implementations, plus an encrypting wrapper (`EncryptedPipelineStorage`); the storage classes are also available from the `@webblackbox/pipeline/storage` subpath
- **IndexedDB Quota Recovery** — Indexed storage evicts oldest sessions on quota pressure (best-effort)

This fork does not publish the package to npm; use it from the pnpm workspace (`"@webblackbox/pipeline": "workspace:*"`) or build it with `pnpm --filter @webblackbox/pipeline build`.

## Usage

### Basic Pipeline

```typescript
import { FlightRecorderPipeline, MemoryPipelineStorage } from "@webblackbox/pipeline";
import type { SessionMetadata } from "@webblackbox/protocol";

const session: SessionMetadata = {
  sid: "S-1706000000000-abc",
  tabId: 123,
  startedAt: Date.now(),
  mode: "lite",
  url: "https://example.com",
  tags: ["debug"]
};

const pipeline = new FlightRecorderPipeline({
  session,
  storage: new MemoryPipelineStorage(),
  maxChunkBytes: 512 * 1024, // 512KB per chunk
  chunkCodec: "gzip" // supported codecs: none | gzip | br | zst
});

// Start the pipeline
await pipeline.start();

// Ingest recorder output: events without a `privacy` classification are rejected
for (const event of events) {
  await pipeline.ingest(event);
}

// Flush remaining events
await pipeline.flush();

// Build search indexes on demand from persisted chunks
const indexes = await pipeline.finalizeIndexes();

// Export as archive
const result = await pipeline.exportBundle({
  passphrase: "required-encryption-key", // every archive is encrypted (8+ characters)
  includeScreenshots: true,
  maxArchiveBytes: 100 * 1024 * 1024,
  recentWindowMs: 20 * 60 * 1000
});

console.log(`Exported: ${result.fileName} (${result.bytes.length} bytes)`);
```

`includeScreenshots`, `includeScreenRecordings`, `maxArchiveBytes`, and `recentWindowMs` are optional export filters. Omitted ones fall back to `DEFAULT_EXPORT_POLICY` from `@webblackbox/protocol`: no screenshots, no screen recordings, at most 100 MiB, the last 20 minutes. Pass `null` for `maxArchiveBytes` or `recentWindowMs` to drop that limit; with screenshots and recordings included and both limits `null`, the export holds the full retained session. `exportBundle` throws without a passphrase of at least 8 characters.

### Optional At-Rest Storage Encryption

`EncryptedPipelineStorage` wraps another storage and encrypts what it persists with AES-GCM (for example when using IndexedDB storage).

```typescript
import {
  EncryptedPipelineStorage,
  IndexedDbPipelineStorage,
  derivePipelineStorageKey
} from "@webblackbox/pipeline";

const derived = await derivePipelineStorageKey("cache-passphrase");

const storage = new EncryptedPipelineStorage(
  new IndexedDbPipelineStorage("webblackbox-flight-recorder"),
  {
    key: derived.key
  }
);

// Persist derived.salt + derived.iterations with your own secure key policy.
```

Note: chunk and blob bytes, indexes, integrity manifests and session metadata are encrypted at rest. What lookups need stays plaintext: the session id, tab id, start time and mode, chunk time-index entries, and blob hash, MIME type and size. `derivePipelineStorageKey` uses 120,000 PBKDF2 iterations unless `options.iterations` says otherwise.

### Blob Storage

```typescript
// Store binary data (screenshots, DOM snapshots, response bodies)
const hash = await pipeline.putBlob("image/webp", screenshotBytes);
// Returns SHA-256 hash for content-addressable retrieval
```

`ingest` also moves the text of WebSocket frames and SSE messages longer than 16,384 characters into a `text/plain` blob (`frame.payloadHash` / `dataHash`), leaving a 512-character head inline.

## Event Chunking

The `EventChunker` groups events into size-bounded chunks:

```typescript
import { EventChunker } from "@webblackbox/pipeline";

const chunker = new EventChunker(
  512 * 1024, // Max 512KB per chunk
  "gzip" // Codec: none | gzip | br | zst
);

// Append events; returns a finalized chunk when size threshold is reached
const chunk = await chunker.append(event);
if (chunk) {
  // chunk.meta: ChunkTimeIndexEntry (timestamps, size, hash)
  // chunk.bytes: Uint8Array (encoded NDJSON)
  // chunk.events: WebBlackboxEvent[] (original events)
}

// Flush remaining events
const remaining = await chunker.flush();
```

### FinalizedChunk

```typescript
type FinalizedChunk = {
  meta: ChunkTimeIndexEntry; // Chunk metadata for indexing
  bytes: Uint8Array; // Encoded event data
  events: WebBlackboxEvent[]; // Original events in this chunk
};
```

## Indexing

`FlightRecorderPipeline` does not retain full request/text indexes in memory while recording. It rebuilds them from persisted chunks when `finalizeIndexes()` or `exportBundle()` runs, which keeps long-running extension sessions memory-bounded.

The `EventIndexer` builds three types of indexes:

```typescript
import { EventIndexer } from "@webblackbox/pipeline";

const indexer = new EventIndexer();

// Add chunk metadata for time-based indexing
indexer.addChunk(chunkMeta);

// Add events for request and text indexing
indexer.addEvents(events);

// Get all indexes
const { time, request, inverted } = indexer.snapshot();
```

### Index Types

| Index              | Purpose                      | Structure                                                                                   |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------- |
| **Time Index**     | Locate chunks by timestamp   | `{ chunkId, seq, tStart, tEnd, monoStart, monoEnd, eventCount, byteLength, codec, sha256 }` |
| **Request Index**  | Map request IDs to event IDs | `{ reqId, eventIds[] }`                                                                     |
| **Inverted Index** | Full-text search             | `{ term, eventIds[] }`                                                                      |

## Codec

```typescript
import { encodeEventsNdjson, decodeEventsNdjson } from "@webblackbox/pipeline";

// Encode events as NDJSON
const bytes = encodeEventsNdjson(events);

// Decode NDJSON back to events
const decoded = decodeEventsNdjson(bytes);
```

## SHA-256 Hashing

```typescript
import { sha256Hex } from "@webblackbox/pipeline";

const hash = await sha256Hex(data); // Returns hex string
```

## Storage Interface

```typescript
import type {
  PipelineStorage,
  StoredBlob,
  StoredChunk,
  StoredIndexes
} from "@webblackbox/pipeline";
import type { ChunkTimeIndexEntry, HashesManifest, SessionMetadata } from "@webblackbox/protocol";

// Implement custom storage backend
class CustomStorage implements PipelineStorage {
  async putSession(metadata: SessionMetadata): Promise<void> {
    /* ... */
  }
  async getSession(sid: string): Promise<SessionMetadata | undefined> {
    /* ... */
  }
  async putChunk(chunk: StoredChunk): Promise<void> {
    /* ... */
  }
  async listChunks(sid: string): Promise<StoredChunk[]> {
    /* ... */
  }
  async getLatestChunkMeta(sid: string): Promise<ChunkTimeIndexEntry | undefined> {
    /* ... */
  }
  async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    /* ... */
  }
  async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    /* ... */
  }
  async getBlob(hash: string): Promise<StoredBlob | undefined> {
    /* ... */
  }
  async listBlobs(): Promise<StoredBlob[]> {
    /* ... */
  }
  async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    /* ... */
  }
  async getIndexes(sid: string): Promise<StoredIndexes> {
    /* ... */
  }
  async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    /* ... */
  }
  async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    /* ... */
  }
  async deleteSession(sid: string, blobHashes?: string[]): Promise<void> {
    /* ... */
  }
  // Optional: listSessions(): Promise<SessionMetadata[]>
}
```

### MemoryPipelineStorage

In-memory implementation using Maps. Features:

- Blob deduplication by SHA-256 hash
- Reference counting for shared blobs
- Suitable for extension offscreen documents and testing

## Archive Format

### Structure

```
session.webblackbox (ZIP)
├── manifest.json           # Plaintext envelope: protocolVersion 2 + encryption parameters
├── meta/
│   └── manifest.json       # Full export manifest (encrypted)
├── privacy/
│   └── manifest.json       # Privacy manifest (encrypted)
├── events/
│   ├── C-000001.ndjson     # Event chunks (NDJSON)
│   └── ...
├── index/
│   ├── time.json           # Time-based chunk index
│   ├── req.json            # Request ID mapping
│   └── inv.json            # Full-text search index
├── blobs/
│   ├── sha256-<hash>.webp  # Binary blobs (screenshots, etc.)
│   └── ...
└── integrity/
    └── hashes.json         # SHA-256 hashes (plaintext)
```

Everything except `manifest.json` and `integrity/hashes.json` is encrypted. The ZIP is written
with `STORE` (no compression), since ciphertext does not compress.

### Encryption

```typescript
const result = await pipeline.exportBundle({
  passphrase: "my-secret-key"
});
```

Every archive is encrypted: `exportBundle` and `createWebBlackboxArchive` refuse to write one
without a passphrase of at least 8 characters (trimmed).

- **KDF**: PBKDF2 with SHA-256, 600,000 iterations (`ARCHIVE_KDF_DEFAULT_ITERATIONS`), random salt; readers accept 10,000–10,000,000 iterations from the manifest
- **Encryption**: AES-GCM with per-file random IVs
- **Scope**: Event chunks, indexes, blobs, the privacy manifest and the full manifest
  (`meta/manifest.json`) are encrypted
- **Plaintext `manifest.json`**: only `protocolVersion: 2` and the encryption parameters
- **Integrity**: SHA-256 hashes computed on encrypted content
- **Older archives**: format 1 archives (plaintext manifest, optionally unencrypted) still open

### Archive Creation

```typescript
import { createWebBlackboxArchive, readWebBlackboxArchive } from "@webblackbox/pipeline";

const { bytes, integrity } = await createWebBlackboxArchive(
  {
    manifest, // ExportManifest (written encrypted to meta/manifest.json)
    chunks, // StoredChunk[]
    timeIndex, // ChunkTimeIndexEntry[]
    requestIndex, // RequestIndexEntry[]
    invertedIndex, // InvertedIndexEntry[]
    blobs, // StoredBlob[]
    privacyManifest // PrivacyManifest (see buildPrivacyManifest)
  },
  {
    passphrase: "required-passphrase"
  }
);

// Read it back: verifies integrity, decrypts, decodes the chunks
const archive = await readWebBlackboxArchive(bytes, { passphrase: "required-passphrase" });
console.log(archive.manifest.site.origin, archive.events.length);
```

## License

[MIT](https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE)
