import "fake-indexeddb/auto";

import type { ChunkTimeIndexEntry, SessionMetadata } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  derivePipelineStorageKey,
  EncryptedPipelineStorage,
  IndexedDbPipelineStorage,
  MemoryPipelineStorage,
  type StoredBlob,
  type StoredChunk
} from "./storage.js";

const SESSION_A: SessionMetadata = {
  sid: "S-storage-A",
  tabId: 1,
  startedAt: Date.now(),
  mode: "lite",
  url: "https://example.com/a",
  tags: []
};

const SESSION_B: SessionMetadata = {
  sid: "S-storage-B",
  tabId: 2,
  startedAt: Date.now() + 1,
  mode: "full",
  url: "https://example.com/b",
  tags: []
};

function chunkMeta(chunkId: string, seq: number): ChunkTimeIndexEntry {
  return {
    chunkId,
    seq,
    tStart: seq * 1000,
    tEnd: seq * 1000 + 100,
    monoStart: seq * 1000,
    monoEnd: seq * 1000 + 100,
    eventCount: 1,
    byteLength: 16,
    codec: "none",
    sha256: "a".repeat(64)
  };
}

function createChunk(sid: string, chunkId: string, seq: number, text: string): StoredChunk {
  return {
    sid,
    meta: chunkMeta(chunkId, seq),
    bytes: new TextEncoder().encode(text)
  };
}

function createBlob(hash: string, bytes: Uint8Array): StoredBlob {
  return {
    hash,
    mime: "application/octet-stream",
    size: bytes.byteLength,
    bytes,
    createdAt: Date.now(),
    refCount: 1
  };
}

function createDbName(): string {
  return `wb-storage-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function openRawDb(
  dbName: string,
  version: number,
  onUpgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, version);

    request.onupgradeneeded = () => {
      onUpgrade(request.result);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open raw IndexedDB"));
  });
}

async function writeRawRows(
  db: IDBDatabase,
  storeName: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);

    for (const row of rows) {
      store.put(row);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Raw row write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Raw row write aborted"));
  });
}

describe("storage", () => {
  it("supports memory storage CRUD and session-scoped blob ref-count cleanup", async () => {
    const storage = new MemoryPipelineStorage();
    const hash = "f".repeat(64);

    await storage.putSession(SESSION_A);
    await storage.putSession(SESSION_B);
    await storage.putChunk(createChunk(SESSION_A.sid, "C-2", 2, "second"));
    await storage.putChunk(createChunk(SESSION_A.sid, "C-1", 1, "first"));
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_A.sid);
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_A.sid);
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 2, 3])), SESSION_B.sid);
    await storage.putIndexes(SESSION_A.sid, {
      time: [chunkMeta("C-1", 1)],
      request: [],
      inverted: []
    });
    await storage.putIntegrity(SESSION_A.sid, {
      manifestSha256: "b".repeat(64),
      files: {
        "chunks/C-1.ndjson": "c".repeat(64)
      }
    });

    const chunks = await storage.listChunks(SESSION_A.sid);
    expect(chunks.map((chunk) => chunk.meta.chunkId)).toEqual(["C-1", "C-2"]);
    expect((await storage.getLatestChunkMeta(SESSION_A.sid))?.chunkId).toBe("C-2");
    expect(await storage.getSession(SESSION_A.sid)).toEqual(expect.objectContaining(SESSION_A));
    expect((await storage.getBlob(hash))?.refCount).toBe(2);

    await storage.deleteSession(SESSION_A.sid);
    expect(await storage.getSession(SESSION_A.sid)).toBeUndefined();
    expect((await storage.getBlob(hash))?.refCount).toBe(1);
    expect((await storage.getIndexes(SESSION_A.sid)).time).toEqual([]);
    expect(await storage.getIntegrity(SESSION_A.sid)).toBeUndefined();

    await storage.deleteSession(SESSION_B.sid);
    expect(await storage.getBlob(hash)).toBeUndefined();

    await storage.deleteSession(SESSION_A.sid, ["0".repeat(64), "missing"]);
  });

  it("derives deterministic storage keys with configured PBKDF2 params", async () => {
    const salt = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const derived = await derivePipelineStorageKey("passphrase", {
      salt,
      iterations: 321.9
    });

    expect(derived.iterations).toBe(321);
    expect(Array.from(derived.salt)).toEqual(Array.from(salt));
    expect(derived.key).toBeDefined();
  });

  it("throws a clear error when Web Crypto API is unavailable", async () => {
    const originalCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      await expect(derivePipelineStorageKey("passphrase")).rejects.toThrow(/Web Crypto API/i);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        writable: true,
        value: originalCrypto
      });
    }
  });

  it("encrypts chunk/blob payloads via storage wrapper and decrypts on read", async () => {
    const baseStorage = new MemoryPipelineStorage();
    const key = await derivePipelineStorageKey("cache-passphrase", {
      salt: Uint8Array.from([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    });
    const storage = new EncryptedPipelineStorage(baseStorage, { key: key.key });
    const sid = "S-encrypted";
    const hash = "e".repeat(64);
    const chunk = createChunk(sid, "C-enc", 1, '{"id":"event"}\n');
    const blobBytes = Uint8Array.from([4, 5, 6, 7]);

    await storage.putSession({
      ...SESSION_A,
      sid
    });
    expect(await storage.getSession(sid)).toEqual(expect.objectContaining({ sid }));
    await storage.putChunk(chunk);
    await storage.putBlob(createBlob(hash, blobBytes), sid);
    await storage.putIndexes(sid, {
      time: [chunkMeta("C-enc", 1)],
      request: [],
      inverted: []
    });
    await storage.putIntegrity(sid, {
      manifestSha256: "2".repeat(64),
      files: {}
    });

    const rawChunk = await baseStorage.getChunk(sid, "C-enc");
    const rawBlob = await baseStorage.getBlob(hash);
    expect(rawChunk).toBeDefined();
    expect(rawBlob).toBeDefined();
    expect(Array.from(rawChunk?.bytes.slice(0, 4) ?? [])).toEqual([0x57, 0x42, 0x45, 0x31]);
    expect(Array.from(rawBlob?.bytes.slice(0, 4) ?? [])).toEqual([0x57, 0x42, 0x45, 0x31]);

    const decryptedChunk = await storage.getChunk(sid, "C-enc");
    const decryptedBlob = await storage.getBlob(hash);
    const decryptedList = await storage.listBlobs();
    expect((await storage.getLatestChunkMeta(sid))?.chunkId).toBe("C-enc");
    expect(Array.from(decryptedChunk?.bytes ?? [])).toEqual(Array.from(chunk.bytes));
    expect(Array.from(decryptedBlob?.bytes ?? [])).toEqual(Array.from(blobBytes));
    expect(decryptedList).toHaveLength(1);
    expect(await storage.getIndexes(sid)).toEqual({
      time: [chunkMeta("C-enc", 1)],
      request: [],
      inverted: []
    });
    expect(await storage.getIntegrity(sid)).toEqual({
      manifestSha256: "2".repeat(64),
      files: {}
    });

    await baseStorage.putChunk(createChunk(sid, "C-plain", 2, '{"plain":true}\n'));
    await baseStorage.putBlob(createBlob("b".repeat(64), Uint8Array.from([9, 9, 9])), sid);
    expect(Array.from((await storage.getChunk(sid, "C-plain"))?.bytes ?? [])).toEqual(
      Array.from(new TextEncoder().encode('{"plain":true}\n'))
    );
    expect(Array.from((await storage.getBlob("b".repeat(64)))?.bytes ?? [])).toEqual([9, 9, 9]);

    await expect(storage.getChunk(sid, "missing")).resolves.toBeUndefined();
    await expect(storage.getBlob("c".repeat(64))).resolves.toBeUndefined();
    await storage.deleteSession(sid, [hash, "b".repeat(64)]);
  });

  it("counts one session reference for concurrent puts of the same blob", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const hash = "e".repeat(64);
    const blob = createBlob(hash, Uint8Array.from([1, 2, 3]));

    await storage.putSession(SESSION_A);
    // Identical bodies read in parallel land here at the same time.
    await Promise.all([
      storage.putBlob(blob, SESSION_A.sid),
      storage.putBlob(blob, SESSION_A.sid),
      storage.putBlob(blob, SESSION_A.sid)
    ]);
    expect((await storage.getBlob(hash))?.refCount).toBe(1);

    await storage.deleteSession(SESSION_A.sid);
    expect(await storage.getBlob(hash)).toBeUndefined();
  });

  it("tracks every blob of concurrent puts, so deleting the session leaves none", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const hashes = ["1", "2", "3", "4"].map((digit) => digit.repeat(64));

    await storage.putSession(SESSION_A);
    // Bodies read in parallel are stored at the same time.
    await Promise.all(
      hashes.map((hash, index) =>
        storage.putBlob(createBlob(hash, Uint8Array.from([index])), SESSION_A.sid)
      )
    );
    await storage.deleteSession(SESSION_A.sid);

    for (const hash of hashes) {
      expect(await storage.getBlob(hash)).toBeUndefined();
    }
  });

  it("removes sid-tracked blob refs on indexeddb deleteSession without explicit blobHashes", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const sharedHash = "d".repeat(64);
    const sharedBlob = createBlob(sharedHash, Uint8Array.from([8, 9, 10]));

    await storage.putSession(SESSION_A);
    await storage.putSession(SESSION_B);
    await storage.putChunk(createChunk(SESSION_A.sid, "A-1", 1, "A"));
    await storage.putIndexes(SESSION_A.sid, {
      time: [chunkMeta("A-1", 1)],
      request: [],
      inverted: []
    });
    await storage.putIntegrity(SESSION_A.sid, {
      manifestSha256: "1".repeat(64),
      files: {}
    });

    await storage.putBlob(sharedBlob, SESSION_A.sid);
    await storage.putBlob(sharedBlob, SESSION_A.sid);
    await storage.putBlob(sharedBlob, SESSION_B.sid);
    expect((await storage.getBlob(sharedHash))?.refCount).toBe(2);

    await storage.deleteSession(SESSION_A.sid);
    expect((await storage.getBlob(sharedHash))?.refCount).toBe(1);
    expect(await storage.getSession(SESSION_A.sid)).toBeUndefined();
    expect(await storage.getChunk(SESSION_A.sid, "A-1")).toBeUndefined();
    expect((await storage.getIndexes(SESSION_A.sid)).time).toEqual([]);
    expect(await storage.getIntegrity(SESSION_A.sid)).toBeUndefined();

    await storage.deleteSession(SESSION_B.sid);
    expect(await storage.getBlob(sharedHash)).toBeUndefined();

    await expect(storage.listBlobs()).resolves.toEqual([]);
  });

  it("lists stored session metadata across storage implementations", async () => {
    const memory = new MemoryPipelineStorage();
    const indexedDb = new IndexedDbPipelineStorage(createDbName());
    const key = await derivePipelineStorageKey("list-sessions", {
      salt: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      iterations: 1_000
    });
    const encrypted = new EncryptedPipelineStorage(new MemoryPipelineStorage(), { key: key.key });

    for (const storage of [memory, indexedDb, encrypted]) {
      await expect(storage.listSessions()).resolves.toEqual([]);

      await storage.putSession(SESSION_A);
      await storage.putSession(SESSION_B);
      const listed = await storage.listSessions();
      expect(listed.map((session) => session.sid).sort()).toEqual([SESSION_A.sid, SESSION_B.sid]);

      await storage.deleteSession(SESSION_A.sid);
      await expect(storage.listSessions()).resolves.toEqual([SESSION_B]);
    }
  });

  it("supports legacy indexeddb layouts where chunks store has no sid/seq index", async () => {
    const sid = "S-legacy-layout";
    const dbName = createDbName();
    // Opened at the current version, so no upgrade adds the index behind the storage's back.
    const db = await openRawDb(dbName, 4, (raw) => {
      for (const storeName of ["sessions", "chunks", "blobs", "blobRefs", "indexes", "integrity"]) {
        if (!raw.objectStoreNames.contains(storeName)) {
          raw.createObjectStore(storeName, { keyPath: "key" });
        }
      }
    });
    await writeRawRows(db, "sessions", [
      {
        key: sid,
        value: {
          ...SESSION_A,
          sid,
          startedAt: 10
        }
      }
    ]);
    await writeRawRows(db, "chunks", [
      {
        key: `${sid}:C-2`,
        sid,
        seq: 2,
        value: createChunk(sid, "C-2", 2, "legacy-2")
      },
      {
        key: `${sid}:C-1`,
        sid,
        seq: 1,
        value: createChunk(sid, "C-1", 1, "legacy-1")
      }
    ]);
    db.close();

    const storage = new IndexedDbPipelineStorage(dbName);
    const chunks = await storage.listChunks(sid);
    expect(chunks.map((chunk) => chunk.meta.chunkId)).toEqual(["C-1", "C-2"]);
    expect((await storage.listChunkMetas(sid)).map((meta) => meta.chunkId)).toEqual(["C-1", "C-2"]);
    expect((await storage.getLatestChunkMeta(sid))?.chunkId).toBe("C-2");

    await storage.deleteSession(sid);
    expect(await storage.listChunks(sid)).toEqual([]);
  });

  it("evicts oldest session during quota recovery helper and logs when none is evictable", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const quotaRecovery = (
      storage as unknown as {
        recoverQuotaPressure: (protectedSid?: string) => Promise<boolean>;
      }
    ).recoverQuotaPressure.bind(storage);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(quotaRecovery("S-protected")).resolves.toBe(false);

    await storage.putSession({
      ...SESSION_A,
      sid: "S-oldest",
      startedAt: 1
    });
    await storage.putSession({
      ...SESSION_A,
      sid: "S-newest",
      startedAt: 2
    });

    await expect(quotaRecovery("S-newest")).resolves.toBe(true);
    expect(await storage.getSession("S-oldest")).toBeUndefined();
    expect(await storage.getSession("S-newest")).toEqual(
      expect.objectContaining({ sid: "S-newest" })
    );

    warnSpy.mockRestore();
  });

  it("fails fast when indexeddb runtime is unavailable", async () => {
    const originalIndexedDb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;

    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      const storage = new IndexedDbPipelineStorage(createDbName());
      await expect(storage.putSession(SESSION_A)).rejects.toThrow(/indexedDB is unavailable/i);
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        writable: true,
        value: originalIndexedDb
      });
    }
  });

  it("keeps encrypted indexeddb payloads and still cleans tracked blobs on session delete", async () => {
    const innerStorage = new IndexedDbPipelineStorage(createDbName());
    const key = await derivePipelineStorageKey("idb-passphrase", {
      salt: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16])
    });
    const storage = new EncryptedPipelineStorage(innerStorage, { key: key.key });
    const sid = "S-idb-encrypted";
    const hash = "a".repeat(64);
    const chunk = createChunk(sid, "C-1", 1, '{"kind":"screen.screenshot"}\n');

    await storage.putSession({
      ...SESSION_A,
      sid
    });
    await storage.putBlob(createBlob(hash, Uint8Array.from([1, 3, 3, 7])), sid);
    await storage.putChunk(chunk);

    const rawChunk = await innerStorage.getChunk(sid, "C-1");
    expect(Array.from(rawChunk?.bytes.slice(0, 4) ?? [])).toEqual([0x57, 0x42, 0x45, 0x31]);

    const wrongKey = await derivePipelineStorageKey("other-passphrase", {
      salt: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16])
    });
    const wrongReader = new EncryptedPipelineStorage(innerStorage, { key: wrongKey.key });
    await expect(wrongReader.getChunk(sid, "C-1")).rejects.toThrow(/Unable to decrypt/i);

    await storage.deleteSession(sid);
    expect(await innerStorage.getBlob(hash)).toBeUndefined();
  });

  it("lists chunk metadata in sequence order without other sessions' chunks", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());

    await storage.putChunk(createChunk(SESSION_A.sid, "C-2", 2, "a2"));
    await storage.putChunk(createChunk(SESSION_B.sid, "C-1", 1, "b1"));
    await storage.putChunk(createChunk(SESSION_A.sid, "C-1", 1, "a1"));

    expect(await storage.listChunkMetas(SESSION_A.sid)).toEqual([
      chunkMeta("C-1", 1),
      chunkMeta("C-2", 2)
    ]);
  });

  it("describes a session's tracked blobs without reading their bytes", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());
    const first = createBlob("1".repeat(64), Uint8Array.from([1, 2, 3]));
    const second = { ...createBlob("2".repeat(64), new Uint8Array(10)), mime: "text/plain" };

    await storage.putBlob(first, SESSION_A.sid);
    await storage.putBlob(second, SESSION_A.sid);
    // Same bytes under another type: the stored copy's type is what gets exported.
    await storage.putBlob({ ...first, mime: "text/html" }, SESSION_B.sid);

    expect(
      (await storage.listSessionBlobInfo(SESSION_A.sid)).sort((a, b) =>
        a.hash.localeCompare(b.hash)
      )
    ).toEqual([
      { hash: first.hash, mime: first.mime, size: 3 },
      { hash: second.hash, mime: "text/plain", size: 10 }
    ]);
    expect(await storage.listSessionBlobInfo(SESSION_B.sid)).toEqual([
      { hash: first.hash, mime: first.mime, size: 3 }
    ]);
  });

  it("writes a blob and its session reference in one transaction", async () => {
    const storage = new IndexedDbPipelineStorage(createDbName());

    await storage.putSession(SESSION_A);

    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");

    try {
      for (let index = 0; index < 20; index += 1) {
        const hash = index.toString(16).padStart(64, "0");
        await storage.putBlob(createBlob(hash, Uint8Array.from([index])), SESSION_A.sid);
      }

      const writes = transaction.mock.calls.filter(([, mode]) => mode === "readwrite");
      expect(writes).toHaveLength(20);
    } finally {
      transaction.mockRestore();
    }
  });

  it("migrates per-session hash lists from version 3 to one row per tracked blob", async () => {
    const dbName = createDbName();
    const shared = createBlob("a".repeat(64), Uint8Array.from([1, 2]));
    const onlyA = createBlob("b".repeat(64), Uint8Array.from([3, 4, 5]));
    const db = await openRawDb(dbName, 3, (raw) => {
      for (const storeName of ["sessions", "chunks", "blobs", "blobRefs", "indexes", "integrity"]) {
        raw.createObjectStore(storeName, { keyPath: "key" });
      }
    });

    await writeRawRows(db, "sessions", [
      { key: SESSION_A.sid, value: SESSION_A },
      { key: SESSION_B.sid, value: SESSION_B }
    ]);
    await writeRawRows(db, "blobs", [
      { key: shared.hash, value: { ...shared, refCount: 2 } },
      { key: onlyA.hash, value: onlyA }
    ]);
    await writeRawRows(db, "blobRefs", [
      // A hash whose blob is gone is dropped; a malformed entry too.
      { key: SESSION_A.sid, value: [shared.hash, onlyA.hash, "c".repeat(64), "not-a-hash"] },
      { key: SESSION_B.sid, value: [shared.hash] }
    ]);
    db.close();

    const storage = new IndexedDbPipelineStorage(dbName);

    expect(
      (await storage.listSessionBlobInfo(SESSION_A.sid)).sort((a, b) =>
        a.hash.localeCompare(b.hash)
      )
    ).toEqual([
      { hash: shared.hash, mime: shared.mime, size: 2 },
      { hash: onlyA.hash, mime: onlyA.mime, size: 3 }
    ]);

    // Already tracked after the migration: no second reference.
    await storage.putBlob(shared, SESSION_A.sid);
    expect((await storage.getBlob(shared.hash))?.refCount).toBe(2);

    await storage.deleteSession(SESSION_A.sid);
    expect(await storage.getBlob(onlyA.hash)).toBeUndefined();
    expect((await storage.getBlob(shared.hash))?.refCount).toBe(1);

    await storage.deleteSession(SESSION_B.sid);
    expect(await storage.listBlobs()).toEqual([]);
  });
});
