import { describe, expect, it } from "vitest";

import type { PrivacyDataCategory, SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { createArchiveBlobSink } from "./archive-blob-sink.js";
import { encodeArchiveJson } from "./archive-writer.js";
import { readWebBlackboxArchive } from "./exporter.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import { MemoryPipelineStorage, type PipelineStorage, type StoredBlob } from "./storage.js";

const PASSPHRASE = "session-export-passphrase";
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const SESSION: SessionMetadata = {
  sid: "S-session-export",
  tabId: 1,
  startedAt: T0,
  endedAt: T0 + 60_000,
  mode: "full",
  url: "https://example.test/app",
  tags: []
};
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

function createEvent(
  index: number,
  type: WebBlackboxEvent["type"],
  data: WebBlackboxEvent["data"]
): WebBlackboxEvent {
  const category: PrivacyDataCategory =
    type === "screen.screenshot"
      ? "screenshots"
      : type.startsWith("network.")
        ? "network"
        : "console";

  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    id: `E-${String(index).padStart(4, "0")}`,
    t: T0 + index * 100,
    mono: index * 100,
    type,
    privacy: { category, sensitivity: "low", redacted: true },
    data
  };
}

/** A sentence of distinct words, so every event adds terms to the inverted index. */
function sentence(index: number, words: number): string {
  return Array.from(
    { length: words },
    (_, offset) => `${WORDS[(index + offset) % WORDS.length]}${index * 31 + offset}`
  ).join(" ");
}

/** Counts reads that load a whole session or a blob. */
class CountingStorage extends MemoryPipelineStorage {
  public listChunksCalls = 0;
  public listBlobsCalls = 0;
  public readonly blobReads: string[] = [];

  public override async listChunks(sid: string) {
    this.listChunksCalls += 1;
    return super.listChunks(sid);
  }

  public override async listBlobs() {
    this.listBlobsCalls += 1;
    return super.listBlobs();
  }

  public override async getBlob(hash: string): Promise<StoredBlob | undefined> {
    this.blobReads.push(hash);
    return super.getBlob(hash);
  }
}

/** A custom storage implementing only the required methods. */
function withoutOptionalMethods(storage: MemoryPipelineStorage): PipelineStorage {
  return {
    putSession: (metadata) => storage.putSession(metadata),
    getSession: (sid) => storage.getSession(sid),
    putChunk: (chunk) => storage.putChunk(chunk),
    listChunks: (sid) => storage.listChunks(sid),
    getLatestChunkMeta: (sid) => storage.getLatestChunkMeta(sid),
    getChunk: (sid, chunkId) => storage.getChunk(sid, chunkId),
    putBlob: (blob, sid) => storage.putBlob(blob, sid),
    getBlob: (hash) => storage.getBlob(hash),
    listBlobs: () => storage.listBlobs(),
    putIndexes: (sid, indexes) => storage.putIndexes(sid, indexes),
    getIndexes: (sid) => storage.getIndexes(sid),
    putIntegrity: (sid, manifest) => storage.putIntegrity(sid, manifest),
    getIntegrity: (sid) => storage.getIntegrity(sid),
    deleteSession: (sid, hashes) => storage.deleteSession(sid, hashes)
  };
}

type RecordedSession = {
  pipeline: FlightRecorderPipeline;
  eventIds: string[];
  screenshotHashes: string[];
  bodyHashes: string[];
};

/** Console text, a screenshot every 10th event and a JSON response body every 7th. */
async function recordSession(
  storage: PipelineStorage,
  options: { events: number; blobBytes: number; words: number }
): Promise<RecordedSession> {
  const pipeline = new FlightRecorderPipeline({
    session: SESSION,
    storage,
    maxChunkBytes: 4 * 1024,
    chunkCodec: "gzip"
  });
  const eventIds: string[] = [];
  const screenshotHashes: string[] = [];
  const bodyHashes: string[] = [];

  await pipeline.start();

  for (let index = 0; index < options.events; index += 1) {
    let event: WebBlackboxEvent;

    if (index % 10 === 0) {
      const bytes = Uint8Array.from({ length: options.blobBytes }, (_, at) => (at * index) % 251);
      const shotId = await pipeline.putBlob("image/webp", bytes);
      screenshotHashes.push(shotId);
      event = createEvent(index, "screen.screenshot", { shotId, format: "webp" });
    } else if (index % 7 === 0) {
      const body = JSON.stringify({ index, text: sentence(index, options.words) });
      const bodyHash = await pipeline.putBlob(
        "application/json",
        new TextEncoder().encode(body.padEnd(options.blobBytes, " "))
      );
      bodyHashes.push(bodyHash);
      event = createEvent(index, "network.response", {
        reqId: `R-${index}`,
        status: 200,
        bodyHash
      });
    } else {
      event = createEvent(index, "console.entry", {
        level: "log",
        text: sentence(index, options.words)
      });
    }

    eventIds.push(event.id);
    await pipeline.ingest(event);
  }

  await pipeline.flush();
  return { pipeline, eventIds, screenshotHashes, bodyHashes };
}

describe("streaming session export", () => {
  it("streams the archive in parts that add up to the reported size", async () => {
    const { pipeline, eventIds } = await recordSession(new MemoryPipelineStorage(), {
      events: 60,
      blobBytes: 2048,
      words: 6
    });
    const sink = createArchiveBlobSink(1024);
    const exported = await pipeline.exportArchive(sink.sink, {
      passphrase: PASSPHRASE,
      includeScreenshots: true,
      maxArchiveBytes: null,
      recentWindowMs: null
    });
    const blob = sink.toBlob();
    const parsed = await readWebBlackboxArchive(new Uint8Array(await blob.arrayBuffer()), {
      passphrase: PASSPHRASE
    });

    expect(exported.fileName).toBe(`${SESSION.sid}.webblackbox`);
    expect(blob.size).toBe(exported.sizeBytes);
    expect(sink.size).toBe(exported.sizeBytes);
    expect(blob.type).toBe("application/zip");
    expect(parsed.events.map((event) => event.id)).toEqual(eventIds);
    expect(parsed.manifest.chunkCodec).toBe("gzip");
    expect(parsed.integrity).toEqual(exported.integrity);
  });

  it("reads chunks one at a time and never loads blobs the policy leaves out", async () => {
    const storage = new CountingStorage();
    const { pipeline, screenshotHashes, bodyHashes } = await recordSession(storage, {
      events: 80,
      blobBytes: 1024,
      words: 4
    });

    storage.blobReads.length = 0;
    const exported = await pipeline.exportBundle({ passphrase: PASSPHRASE });
    await pipeline.finalizeIndexes();
    const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });
    const readHashes = new Set(storage.blobReads);

    expect(storage.listChunksCalls).toBe(0);
    expect(storage.listBlobsCalls).toBe(0);
    expect(screenshotHashes.some((hash) => readHashes.has(hash))).toBe(false);
    expect(bodyHashes.every((hash) => readHashes.has(hash))).toBe(true);
    expect(parsed.events.some((event) => event.type === "screen.screenshot")).toBe(false);
    expect(exported.privacyManifest.totals?.blobs).toBe(bodyHashes.length);
  });

  it("keeps archives within maxArchiveBytes and keeps the newest events", async () => {
    const { pipeline, eventIds } = await recordSession(new MemoryPipelineStorage(), {
      events: 240,
      blobBytes: 3000,
      words: 40
    });
    const full = await pipeline.exportBundle({
      passphrase: PASSPHRASE,
      includeScreenshots: true,
      maxArchiveBytes: null,
      recentWindowMs: null
    });

    for (const fraction of [0.2, 0.45, 0.8]) {
      const maxArchiveBytes = Math.floor(full.bytes.byteLength * fraction);
      const exported = await pipeline.exportBundle({
        passphrase: PASSPHRASE,
        includeScreenshots: true,
        maxArchiveBytes,
        recentWindowMs: null
      });
      const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });
      const ids = parsed.events.map((event) => event.id);

      expect(exported.bytes.byteLength).toBeLessThanOrEqual(maxArchiveBytes);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThan(eventIds.length);
      expect(ids).toEqual(eventIds.slice(eventIds.length - ids.length));
    }
  });

  it("exports from storages without the optional metadata methods", async () => {
    const inner = new MemoryPipelineStorage();
    const storage = withoutOptionalMethods(inner);
    const { pipeline, eventIds, bodyHashes } = await recordSession(storage, {
      events: 40,
      blobBytes: 512,
      words: 3
    });
    const exported = await pipeline.exportBundle({
      passphrase: PASSPHRASE,
      maxArchiveBytes: 64 * 1024,
      recentWindowMs: null
    });
    const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });

    expect(exported.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(parsed.events.map((event) => event.id)).toEqual(
      eventIds.filter((id) => Number(id.slice(2)) % 10 !== 0)
    );
    expect(exported.privacyManifest.totals?.blobs).toBe(bodyHashes.length);
  });
});

const MINUTE_MS = 60_000;

/** A console line every `stepMs`, a JSON body every 5th event: a long, sparse recording. */
async function recordLongSession(
  storage: PipelineStorage,
  options: { events: number; stepMs: number; session?: SessionMetadata }
): Promise<{ pipeline: FlightRecorderPipeline; eventIds: string[] }> {
  const session = options.session ?? SESSION;
  const pipeline = new FlightRecorderPipeline({
    session,
    storage,
    maxChunkBytes: 4 * 1024,
    chunkCodec: "gzip"
  });
  const eventIds: string[] = [];

  await pipeline.start();

  for (let index = 0; index < options.events; index += 1) {
    const base =
      index % 5 === 0
        ? createEvent(index, "network.response", {
            reqId: `R-${index}`,
            status: 200,
            bodyHash: await pipeline.putBlob(
              "application/json",
              new TextEncoder().encode(JSON.stringify({ index, text: sentence(index, 8) }))
            )
          })
        : createEvent(index, "console.entry", { level: "log", text: sentence(index, 6) });
    const event = {
      ...base,
      sid: session.sid,
      t: T0 + index * options.stepMs,
      mono: index * options.stepMs
    };

    eventIds.push(event.id);
    await pipeline.ingest(event);
  }

  await pipeline.flush();
  return { pipeline, eventIds };
}

describe("export completeness", () => {
  it("exports a session longer than the old 20-minute window whole, chunk by chunk", async () => {
    const storage = new CountingStorage();
    // Two hours, one event every 10 s: six times the old default window.
    const { pipeline, eventIds } = await recordLongSession(storage, {
      events: 720,
      stepMs: 10_000
    });
    const sink = createArchiveBlobSink(16 * 1024);
    let largestPart = 0;
    const exported = await pipeline.exportArchive(
      (part) => {
        largestPart = Math.max(largestPart, part.byteLength);
        return sink.sink(part);
      },
      { passphrase: PASSPHRASE }
    );
    const parsed = await readWebBlackboxArchive(new Uint8Array(await sink.toBlob().arrayBuffer()), {
      passphrase: PASSPHRASE
    });
    const storedChunks = (await storage.listChunkMetas(SESSION.sid)).length;

    expect(parsed.events.map((event) => event.id)).toEqual(eventIds);
    expect(parsed.manifest.stats.durationMs).toBe(719 * 10_000);
    expect(parsed.manifest.completeness).toEqual({
      storedEvents: 720,
      storedChunks,
      truncations: []
    });
    // The predicted size is exact, and nothing loads the session whole: chunks are read one at a
    // time. The largest part written is an index, the only entry that grows with the session.
    const largestIndex = Math.max(
      encodeArchiveJson(parsed.requestIndex, "compact").byteLength,
      encodeArchiveJson(parsed.invertedIndex, "compact").byteLength
    );

    expect(sink.size).toBe(exported.sizeBytes);
    expect(storage.listChunksCalls).toBe(0);
    expect(storage.listBlobsCalls).toBe(0);
    expect(largestPart).toBeLessThanOrEqual(largestIndex + 1024);
  });

  it("records what a recent window leaves out", async () => {
    const { pipeline } = await recordLongSession(new MemoryPipelineStorage(), {
      events: 360,
      stepMs: 10_000,
      session: { ...SESSION, endedAt: T0 + 359 * 10_000 }
    });
    const exported = await pipeline.exportBundle({
      passphrase: PASSPHRASE,
      recentWindowMs: 30 * MINUTE_MS
    });
    const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });
    const completeness = parsed.manifest.completeness;
    const cutoff = T0 + 359 * 10_000 - 30 * MINUTE_MS;
    const olderEvents = 360 - parsed.events.length;

    expect(parsed.events.every((event) => event.t >= cutoff)).toBe(true);
    expect(olderEvents).toBe(Math.ceil((cutoff - T0) / 10_000));
    expect(completeness?.storedEvents).toBe(360);
    expect(completeness?.truncations).toHaveLength(1);
    expect(completeness?.truncations[0]).toMatchObject({
      reason: "recent-window",
      events: olderEvents,
      fromT: T0,
      limit: 30 * MINUTE_MS
    });
    expect(completeness?.truncations[0]?.chunks).toBeGreaterThan(0);
    expect(completeness?.truncations[0]?.toT).toBeLessThan(cutoff);
  });

  it("records what a size limit leaves out, adding up to the stored events", async () => {
    const { pipeline, eventIds } = await recordSession(new MemoryPipelineStorage(), {
      events: 240,
      blobBytes: 3000,
      words: 40
    });
    const full = await pipeline.exportBundle({ passphrase: PASSPHRASE, includeScreenshots: true });
    const maxArchiveBytes = Math.floor(full.bytes.byteLength * 0.4);
    const exported = await pipeline.exportBundle({
      passphrase: PASSPHRASE,
      includeScreenshots: true,
      maxArchiveBytes
    });
    const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });
    const truncations = parsed.manifest.completeness?.truncations ?? [];
    const firstKept = parsed.events[0];

    expect(truncations.map((row) => row.reason)).toEqual(["size-limit"]);
    expect(truncations[0]?.limit).toBe(maxArchiveBytes);
    expect(parsed.events.length + (truncations[0]?.events ?? 0)).toBe(eventIds.length);
    expect(truncations[0]?.toT).toBeLessThan(firstKept?.t ?? 0);
  });

  it("keeps the interruption of a recording that ended without Stop", async () => {
    const interruption = {
      reason: "service-worker-restart" as const,
      detectedAt: T0 + 5 * MINUTE_MS,
      lastSeenAt: T0 + 4 * MINUTE_MS
    };
    const { pipeline } = await recordLongSession(new MemoryPipelineStorage(), {
      events: 20,
      stepMs: 1_000,
      session: { ...SESSION, interruption }
    });
    const exported = await pipeline.exportBundle({ passphrase: PASSPHRASE });
    const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });

    expect(parsed.manifest.completeness?.interruption).toEqual(interruption);
    expect(parsed.manifest.completeness?.truncations).toEqual([]);
  });

  it("records a stored chunk that cannot be read back", async () => {
    class LosingStorage extends MemoryPipelineStorage {
      public lostChunkId: string | null = null;

      public override async getChunk(sid: string, chunkId: string) {
        return chunkId === this.lostChunkId ? undefined : super.getChunk(sid, chunkId);
      }
    }

    const storage = new LosingStorage();
    const { pipeline, eventIds } = await recordLongSession(storage, {
      events: 200,
      stepMs: 1_000
    });
    const metas = await storage.listChunkMetas(SESSION.sid);
    const lost = metas[1];

    storage.lostChunkId = lost?.chunkId ?? null;
    const exported = await pipeline.exportBundle({ passphrase: PASSPHRASE });
    const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });

    expect(parsed.events).toHaveLength(eventIds.length - (lost?.eventCount ?? 0));
    expect(parsed.manifest.completeness?.truncations).toEqual([
      {
        reason: "chunk-unreadable",
        events: lost?.eventCount,
        chunks: 1,
        fromT: lost?.tStart,
        toT: lost?.tEnd
      }
    ]);
  });
});
