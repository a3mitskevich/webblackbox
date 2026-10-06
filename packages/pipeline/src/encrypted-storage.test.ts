import "fake-indexeddb/auto";

import type { SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { EncryptedPipelineStorage } from "./encrypted-storage.js";
import { readWebBlackboxArchive } from "./exporter.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import {
  IndexedDbPipelineStorage,
  MemoryPipelineStorage,
  type PipelineStorage,
  type StoredChunk
} from "./storage.js";
import { generatePipelineStorageKeyBytes, importPipelineStorageKey } from "./storage-crypto.js";

const MARKER_URL = "PLANTED-URL-7f3a";
const MARKER_TITLE = "PLANTED-TITLE-91c2";
const MARKER_TAG = "PLANTED-TAG-55de";
const MARKER_BODY = "PLANTED-BODY-0b8e";
const MARKER_CONSOLE = "PLANTED-CONSOLE-a41f";
const MARKER_BLOB = "PLANTED-BLOB-c6d0";
const MARKERS = [MARKER_URL, MARKER_TITLE, MARKER_TAG, MARKER_BODY, MARKER_CONSOLE, MARKER_BLOB];
const EXPORT_PASSPHRASE = "at-rest-test-passphrase";
const WBE1_MAGIC = [0x57, 0x42, 0x45, 0x31];

function createSession(sid: string): SessionMetadata {
  return {
    sid,
    tabId: 7,
    startedAt: 1_700_000_000_000,
    mode: "full",
    url: `https://app.example.test/checkout?token=${MARKER_URL}`,
    title: `Checkout ${MARKER_TITLE}`,
    tags: [MARKER_TAG]
  };
}

function createEvent(
  sid: string,
  id: string,
  type: WebBlackboxEvent["type"],
  t: number,
  data: WebBlackboxEvent["data"]
): WebBlackboxEvent {
  return {
    v: 1,
    sid,
    tab: 7,
    t,
    mono: t,
    type,
    id,
    privacy: {
      category: type.startsWith("network.") ? "network" : "console",
      sensitivity: "high",
      redacted: false
    },
    data
  };
}

function createDbName(): string {
  return `wb-at-rest-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createSessionKey(): Promise<CryptoKey> {
  return importPipelineStorageKey(generatePipelineStorageKeyBytes());
}

/** Records one session with planted markers in every stored record kind, then exports it. */
async function recordPlantedSession(
  storage: PipelineStorage,
  sid: string
): Promise<Awaited<ReturnType<FlightRecorderPipeline["exportBundle"]>>> {
  const pipeline = new FlightRecorderPipeline({
    session: createSession(sid),
    storage,
    chunkCodec: "none",
    maxChunkBytes: 256
  });

  await pipeline.start();
  const blobHash = await pipeline.putBlob(
    "text/plain",
    new TextEncoder().encode(`screenshot-ish ${MARKER_BLOB}`)
  );
  await pipeline.ingestBatch([
    createEvent(sid, "E-req", "network.request", 1, {
      reqId: "R-1",
      url: `https://api.example.test/pay?card=${MARKER_URL}`,
      method: "POST"
    }),
    createEvent(sid, "E-body", "network.body", 2, {
      reqId: "R-1",
      body: `{"password":"${MARKER_BODY}"}`,
      blobHash
    }),
    createEvent(sid, "E-log", "console.entry", 3, {
      level: "log",
      text: `secret ${MARKER_CONSOLE}`
    })
  ]);
  await pipeline.flush();
  await pipeline.finalizeIndexes();
  return pipeline.exportBundle({
    passphrase: EXPORT_PASSPHRASE,
    includeScreenshots: true,
    includeScreenRecordings: true,
    maxArchiveBytes: null,
    recentWindowMs: null
  });
}

async function readRawDatabase(dbName: string): Promise<Record<string, unknown[]>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open raw IndexedDB"));
  });
  const output: Record<string, unknown[]> = {};

  for (const storeName of Array.from(db.objectStoreNames)) {
    output[storeName] = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error ?? new Error("Raw getAll failed"));
    });
  }

  db.close();
  return output;
}

/** Every string and byte run in a value, bytes read as Latin-1 so ASCII markers stay visible. */
function flattenToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder("latin1").decode(value);
  }

  if (Array.isArray(value)) {
    return value.map(flattenToText).join("\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => `${key}\n${flattenToText(entry)}`)
      .join("\n");
  }

  return "";
}

function rowValues(rows: unknown[] | undefined): Array<Record<string, unknown>> {
  return (rows ?? []).map((row) => (row as { value: Record<string, unknown> }).value);
}

describe("EncryptedPipelineStorage at rest", () => {
  it("leaves no planted marker readable in raw IndexedDB rows, and the export still has them", async () => {
    const dbName = createDbName();
    const storage = new EncryptedPipelineStorage(new IndexedDbPipelineStorage(dbName), {
      key: await createSessionKey()
    });

    const exported = await recordPlantedSession(storage, "S-at-rest");
    const raw = await readRawDatabase(dbName);
    const rawText = flattenToText(raw);

    expect(Object.keys(raw).sort()).toEqual(
      ["blobRefs", "blobs", "chunks", "indexes", "integrity", "sessions"].sort()
    );
    for (const marker of MARKERS) {
      expect(rawText).not.toContain(marker);
    }

    const chunks = rowValues(raw.chunks) as unknown as StoredChunk[];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Array.from(chunk.bytes.slice(0, 4))).toEqual(WBE1_MAGIC);
    }
    for (const blob of rowValues(raw.blobs)) {
      expect(Array.from((blob.bytes as Uint8Array).slice(0, 4))).toEqual(WBE1_MAGIC);
    }

    const [sessionRow] = rowValues(raw.sessions);
    expect(sessionRow).toMatchObject({ sid: "S-at-rest", url: "", tags: [] });
    expect(sessionRow).not.toHaveProperty("title");
    expect(sessionRow?.sealed).toBeInstanceOf(Uint8Array);
    expect(rowValues(raw.indexes)[0]).toMatchObject({ time: [], request: [], inverted: [] });
    expect(rowValues(raw.integrity)[0]).toMatchObject({ manifestSha256: "", files: {} });

    const archive = await readWebBlackboxArchive(exported.bytes, {
      passphrase: EXPORT_PASSPHRASE
    });
    const archiveText = JSON.stringify(archive.events);
    expect(archiveText).toContain(MARKER_URL);
    expect(archiveText).toContain(MARKER_BODY);
    expect(archiveText).toContain(MARKER_CONSOLE);
  });

  it("finds the planted markers in raw rows without the wrapper (control)", async () => {
    const dbName = createDbName();

    await recordPlantedSession(new IndexedDbPipelineStorage(dbName), "S-plain");
    const rawText = flattenToText(await readRawDatabase(dbName));

    for (const marker of MARKERS) {
      expect(rawText).toContain(marker);
    }
  });

  it("round-trips sealed session metadata, indexes and integrity", async () => {
    const inner = new MemoryPipelineStorage();
    const storage = new EncryptedPipelineStorage(inner, { key: await createSessionKey() });
    const session = createSession("S-round-trip");
    const indexes = {
      time: [],
      request: [{ reqId: "R-1", eventIds: ["E-1"] }],
      inverted: [{ term: MARKER_BODY.toLowerCase(), eventIds: ["E-1"] }]
    };
    const integrity = { manifestSha256: "f".repeat(64), files: { "manifest.json": "a" } };

    await storage.putSession(session);
    await storage.putIndexes(session.sid, indexes);
    await storage.putIntegrity(session.sid, integrity);

    expect(await storage.getSession(session.sid)).toEqual(session);
    expect(await storage.listSessions()).toEqual([session]);
    expect(await storage.getIndexes(session.sid)).toEqual(indexes);
    expect(await storage.getIntegrity(session.sid)).toEqual(integrity);
    expect(await inner.getSession(session.sid)).toMatchObject({
      sid: session.sid,
      startedAt: session.startedAt,
      url: "",
      tags: []
    });
    expect(await inner.getIndexes(session.sid)).toMatchObject({
      time: [],
      request: [],
      inverted: []
    });
  });

  it("refuses a sealed record moved under another session id", async () => {
    const inner = new MemoryPipelineStorage();
    const storage = new EncryptedPipelineStorage(inner, { key: await createSessionKey() });

    await storage.putSession(createSession("S-original"));
    const sealedRow = await inner.getSession("S-original");
    await inner.putSession({ ...(sealedRow as SessionMetadata), sid: "S-moved" });

    await expect(storage.getSession("S-moved")).rejects.toThrow(/Unable to decrypt/);
  });

  it("purges sessions sealed with another key and plaintext rows, keeping its own", async () => {
    const dbName = createDbName();
    const inner = new IndexedDbPipelineStorage(dbName);
    const previousBrowserSession = new EncryptedPipelineStorage(inner, {
      key: await createSessionKey()
    });
    const current = new EncryptedPipelineStorage(inner, { key: await createSessionKey() });
    const ownSession = createSession("S-current");

    await recordPlantedSession(previousBrowserSession, "S-old-key");
    await recordPlantedSession(inner, "S-legacy-plaintext");
    await current.putSession(ownSession);

    expect((await current.listSessions()).map((session) => session.sid).sort()).toEqual([
      "S-current",
      "S-legacy-plaintext",
      "S-old-key"
    ]);

    const result = await current.purgeUnreadableSessions();

    expect(result).toEqual({ deleted: ["S-legacy-plaintext", "S-old-key"], failed: [] });
    expect((await inner.listSessions()).map((session) => session.sid)).toEqual(["S-current"]);
    expect(await inner.listChunks("S-old-key")).toEqual([]);
    expect(await inner.listChunks("S-legacy-plaintext")).toEqual([]);
    // Their content-addressed blobs are released too, so nothing can dedupe against them.
    expect(await inner.listBlobs()).toEqual([]);
    expect(await current.getSession("S-current")).toEqual(ownSession);

    // Recording continues under the current key after the purge.
    await recordPlantedSession(current, "S-next");
    expect((await current.getSession("S-next"))?.title).toContain(MARKER_TITLE);
    expect((await current.listChunks("S-next")).length).toBeGreaterThan(0);
  });

  it("lists unreadable sessions with their placeholder fields only", async () => {
    const inner = new MemoryPipelineStorage();
    const writer = new EncryptedPipelineStorage(inner, { key: await createSessionKey() });
    const reader = new EncryptedPipelineStorage(inner, { key: await createSessionKey() });

    await writer.putSession(createSession("S-foreign"));

    expect(await reader.listSessions()).toEqual([
      { sid: "S-foreign", tabId: 7, startedAt: 1_700_000_000_000, mode: "full", url: "", tags: [] }
    ]);
    await expect(reader.getSession("S-foreign")).rejects.toThrow(/Unable to decrypt/);
  });

  it("requires a storage that can list sessions to purge", async () => {
    const inner = new MemoryPipelineStorage();
    const withoutListing: PipelineStorage = {
      putSession: (metadata) => inner.putSession(metadata),
      getSession: (sid) => inner.getSession(sid),
      putChunk: (chunk) => inner.putChunk(chunk),
      listChunks: (sid) => inner.listChunks(sid),
      getLatestChunkMeta: (sid) => inner.getLatestChunkMeta(sid),
      getChunk: (sid, chunkId) => inner.getChunk(sid, chunkId),
      putBlob: (blob, sidHint) => inner.putBlob(blob, sidHint),
      getBlob: (hash) => inner.getBlob(hash),
      listBlobs: () => inner.listBlobs(),
      putIndexes: (sid, indexes) => inner.putIndexes(sid, indexes),
      getIndexes: (sid) => inner.getIndexes(sid),
      putIntegrity: (sid, manifest) => inner.putIntegrity(sid, manifest),
      getIntegrity: (sid) => inner.getIntegrity(sid),
      deleteSession: (sid, blobHashes) => inner.deleteSession(sid, blobHashes)
    };
    const storage = new EncryptedPipelineStorage(withoutListing, {
      key: await createSessionKey()
    });

    await expect(storage.purgeUnreadableSessions()).rejects.toThrow(/does not support listing/);
  });
});

describe("pipeline storage session key", () => {
  it("imports a 256-bit key that cannot be exported again", async () => {
    const key = await createSessionKey();

    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    expect(generatePipelineStorageKeyBytes()).not.toEqual(generatePipelineStorageKeyBytes());
  });

  it("rejects raw keys of the wrong size", async () => {
    await expect(importPipelineStorageKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});

describe("IndexedDbPipelineStorage versionchange", () => {
  it("lets the database be deleted while open and reopens it afterwards", async () => {
    const dbName = createDbName();
    const storage = new IndexedDbPipelineStorage(dbName);

    await storage.putSession(createSession("S-before-delete"));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("deleteDatabase failed"));
      request.onblocked = () => reject(new Error("deleteDatabase blocked by an open connection"));
    });

    expect(await storage.getSession("S-before-delete")).toBeUndefined();
    await storage.putSession(createSession("S-after-delete"));
    expect((await storage.listSessions()).map((session) => session.sid)).toEqual([
      "S-after-delete"
    ]);
  });
});
