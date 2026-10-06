import type {
  ChunkTimeIndexEntry,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  SessionMetadata
} from "@webblackbox/protocol";

import { collectBlobHashesFromUnknown, SHA256_HEX_PATTERN } from "./blob-hashes.js";
import { decodeChunkEvents } from "./codec.js";

// The encrypted wrapper lives in its own module; re-exported so existing imports keep working.
export * from "./encrypted-storage.js";

export type StoredChunk = {
  sid: string;
  meta: ChunkTimeIndexEntry;
  bytes: Uint8Array;
};

export type StoredBlob = {
  hash: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
  createdAt: number;
  refCount: number;
};

/** A blob's identity, type and size, without its bytes. */
export type StoredBlobInfo = {
  hash: string;
  mime: string;
  size: number;
};

export type StoredIndexes = {
  time: ChunkTimeIndexEntry[];
  request: RequestIndexEntry[];
  inverted: InvertedIndexEntry[];
};

export type PipelineStorage = {
  putSession(metadata: SessionMetadata): Promise<void>;
  getSession(sid: string): Promise<SessionMetadata | undefined>;
  /**
   * Lists metadata of every session that still has a stored session row.
   * Optional so custom storages written before it existed keep type-checking.
   */
  listSessions?(): Promise<SessionMetadata[]>;
  putChunk(chunk: StoredChunk): Promise<void>;
  listChunks(sid: string): Promise<StoredChunk[]>;
  getLatestChunkMeta(sid: string): Promise<ChunkTimeIndexEntry | undefined>;
  getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined>;
  /**
   * Chunk metadata of a session in sequence order, without the chunk bytes. Optional: exports
   * fall back to `listChunks`, which loads every chunk at once.
   */
  listChunkMetas?(sid: string): Promise<ChunkTimeIndexEntry[]>;
  putBlob(blob: StoredBlob, sidHint?: string): Promise<void>;
  getBlob(hash: string): Promise<StoredBlob | undefined>;
  listBlobs(): Promise<StoredBlob[]>;
  /**
   * Hash, type and size of every blob tracked for a session, without the bytes. Optional:
   * exports fall back to reading each referenced blob.
   */
  listSessionBlobInfo?(sid: string): Promise<StoredBlobInfo[]>;
  putIndexes(sid: string, indexes: StoredIndexes): Promise<void>;
  getIndexes(sid: string): Promise<StoredIndexes>;
  putIntegrity(sid: string, manifest: HashesManifest): Promise<void>;
  getIntegrity(sid: string): Promise<HashesManifest | undefined>;
  deleteSession(sid: string, blobHashes?: string[]): Promise<void>;
};

const EMPTY_INDEXES: StoredIndexes = {
  time: [],
  request: [],
  inverted: []
};
const MAX_QUOTA_RECOVERY_ATTEMPTS = 2;

export class MemoryPipelineStorage implements PipelineStorage {
  private readonly sessions = new Map<string, SessionMetadata>();

  private readonly chunks = new Map<string, StoredChunk[]>();

  private readonly blobs = new Map<string, StoredBlob>();

  private readonly blobRefs = new Map<string, Set<string>>();

  private readonly indexes = new Map<string, StoredIndexes>();

  private readonly integrity = new Map<string, HashesManifest>();

  public async putSession(metadata: SessionMetadata): Promise<void> {
    this.sessions.set(metadata.sid, metadata);
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    return this.sessions.get(sid);
  }

  public async listSessions(): Promise<SessionMetadata[]> {
    return [...this.sessions.values()];
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    const existing = this.chunks.get(chunk.sid) ?? [];
    existing.push(chunk);
    this.chunks.set(chunk.sid, existing);
  }

  public async listChunks(sid: string): Promise<StoredChunk[]> {
    const chunks = this.chunks.get(sid) ?? [];
    return [...chunks].sort((left, right) => left.meta.seq - right.meta.seq);
  }

  public async getLatestChunkMeta(sid: string): Promise<ChunkTimeIndexEntry | undefined> {
    const chunks = this.chunks.get(sid) ?? [];
    let latest: ChunkTimeIndexEntry | undefined;

    for (const chunk of chunks) {
      if (!latest || chunk.meta.seq > latest.seq) {
        latest = chunk.meta;
      }
    }

    return latest;
  }

  public async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    const chunks = this.chunks.get(sid) ?? [];
    return chunks.find((chunk) => chunk.meta.chunkId === chunkId);
  }

  public async listChunkMetas(sid: string): Promise<ChunkTimeIndexEntry[]> {
    return (this.chunks.get(sid) ?? [])
      .map((chunk) => chunk.meta)
      .sort((left, right) => left.seq - right.seq);
  }

  public async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    const trackingSid = normalizeTrackingSid(sidHint);

    if (trackingSid && !this.trackBlobHashForSession(trackingSid, blob.hash)) {
      return;
    }

    const existing = this.blobs.get(blob.hash);

    if (existing) {
      this.blobs.set(blob.hash, {
        ...existing,
        refCount: existing.refCount + 1
      });
      return;
    }

    this.blobs.set(blob.hash, blob);
  }

  public async getBlob(hash: string): Promise<StoredBlob | undefined> {
    return this.blobs.get(hash);
  }

  public async listBlobs(): Promise<StoredBlob[]> {
    return [...this.blobs.values()];
  }

  public async listSessionBlobInfo(sid: string): Promise<StoredBlobInfo[]> {
    return this.getTrackedBlobHashes(sid).flatMap((hash) => {
      const blob = this.blobs.get(hash);
      return blob ? [{ hash, mime: blob.mime, size: blob.size }] : [];
    });
  }

  public async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    this.indexes.set(sid, indexes);
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    return this.indexes.get(sid) ?? EMPTY_INDEXES;
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    this.integrity.set(sid, manifest);
  }

  public async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    return this.integrity.get(sid);
  }

  public async deleteSession(sid: string, blobHashes: string[] = []): Promise<void> {
    const trackedBlobHashes = this.getTrackedBlobHashes(sid);
    const mergedBlobHashes = mergeBlobHashes(blobHashes, trackedBlobHashes);

    this.sessions.delete(sid);
    this.chunks.delete(sid);
    this.blobRefs.delete(sid);
    this.indexes.delete(sid);
    this.integrity.delete(sid);

    for (const hash of mergedBlobHashes) {
      const blob = this.blobs.get(hash);

      if (!blob) {
        continue;
      }

      if (blob.refCount <= 1) {
        this.blobs.delete(hash);
      } else {
        this.blobs.set(hash, {
          ...blob,
          refCount: blob.refCount - 1
        });
      }
    }
  }

  private trackBlobHashForSession(sid: string, hash: string): boolean {
    if (!SHA256_HEX_PATTERN.test(hash)) {
      return true;
    }

    const existing = this.blobRefs.get(sid);

    if (existing?.has(hash)) {
      return false;
    }

    const next = existing ?? new Set<string>();
    next.add(hash);
    this.blobRefs.set(sid, next);
    return true;
  }

  private getTrackedBlobHashes(sid: string): string[] {
    return [...(this.blobRefs.get(sid) ?? new Set<string>())];
  }
}

type DbRow<TData> = {
  key: string;
  value: TData;
};

type ChunkRow = {
  key: string;
  sid: string;
  seq: number;
  value: StoredChunk;
};
type BlobRow = DbRow<StoredBlob>;
/** One blob tracked for one session; `mime` and `size` describe the blob without reading it. */
type BlobRefRow = {
  key: [sid: string, hash: string];
  sid: string;
  hash: string;
  mime: string;
  size: number;
};
/** Before version 4, one row per session listed its blob hashes. */
type LegacyBlobRefsRow = DbRow<string[]>;
type SessionRow = DbRow<SessionMetadata>;
type IndexRow = DbRow<StoredIndexes>;
type IntegrityRow = DbRow<HashesManifest>;

const DB_VERSION = 4;
const BLOB_REFS_KEYED_BY_SID_HASH_VERSION = 4;
const CHUNKS_BY_SID_SEQ_INDEX = "by-sid-seq";

export class IndexedDbPipelineStorage implements PipelineStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  public constructor(private readonly dbName = "webblackbox-pipeline") {}

  public async putSession(metadata: SessionMetadata): Promise<void> {
    await this.put<SessionRow>(
      "sessions",
      {
        key: metadata.sid,
        value: metadata
      },
      {
        allowQuotaRecovery: true,
        protectedSid: metadata.sid
      }
    );
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    const row = await this.get<SessionRow>("sessions", sid);
    return row?.value;
  }

  public async listSessions(): Promise<SessionMetadata[]> {
    const rows = await this.getAll<SessionRow>("sessions");
    return rows.map((row) => row.value);
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    await this.put<ChunkRow>(
      "chunks",
      {
        key: this.chunkKey(chunk.sid, chunk.meta.chunkId),
        sid: chunk.sid,
        seq: chunk.meta.seq,
        value: chunk
      },
      {
        allowQuotaRecovery: true,
        protectedSid: chunk.sid
      }
    );
  }

  public async listChunks(sid: string): Promise<StoredChunk[]> {
    const db = await this.db();

    return runTransaction(db, "chunks", "readonly", (store) => {
      if (!store.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
        return requestToPromise<ChunkRow[]>(store.getAll()).then((rows) =>
          rows
            .map((row) => row.value)
            .filter((chunk) => chunk.sid === sid)
            .sort((left, right) => left.meta.seq - right.meta.seq)
        );
      }

      const index = store.index(CHUNKS_BY_SID_SEQ_INDEX);
      const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);

      return requestToPromise<ChunkRow[]>(index.getAll(range)).then((rows) =>
        rows.map((row) => row.value)
      );
    });
  }

  public async getLatestChunkMeta(sid: string): Promise<ChunkTimeIndexEntry | undefined> {
    const db = await this.db();

    return runTransaction(db, "chunks", "readonly", (store) => {
      if (!store.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
        return requestToPromise<ChunkRow[]>(store.getAll()).then((rows) => {
          const latest = rows
            .map((row) => row.value)
            .filter((chunk) => chunk.sid === sid)
            .sort((left, right) => right.meta.seq - left.meta.seq)[0];

          return latest?.meta;
        });
      }

      const index = store.index(CHUNKS_BY_SID_SEQ_INDEX);
      const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
      return firstCursorValue<ChunkRow>(index.openCursor(range, "prev")).then(
        (row) => row?.value.meta
      );
    });
  }

  public async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    const row = await this.get<ChunkRow>("chunks", this.chunkKey(sid, chunkId));
    return row?.value;
  }

  /** Walks the session's chunks with a cursor, so only one chunk's bytes are loaded at a time. */
  public async listChunkMetas(sid: string): Promise<ChunkTimeIndexEntry[]> {
    const db = await this.db();

    return runTransaction(db, "chunks", "readonly", (store) => {
      if (!store.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
        return collectCursorValues<ChunkRow, ChunkTimeIndexEntry>(store.openCursor(), (row) =>
          row.value.sid === sid ? row.value.meta : null
        ).then((metas) => metas.sort((left, right) => left.seq - right.seq));
      }

      const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
      return collectCursorValues<ChunkRow, ChunkTimeIndexEntry>(
        store.index(CHUNKS_BY_SID_SEQ_INDEX).openCursor(range),
        (row) => row.value.meta
      );
    });
  }

  // Blob writes run one at a time: each reads and rewrites the blob's reference count and the
  // session's tracked hashes in separate transactions, so parallel puts (bodies read in parallel)
  // lost tracked hashes and left their blobs behind when the session was deleted.
  private blobWrites: Promise<void> = Promise.resolve();

  public putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    const write = this.blobWrites.then(() => this.putBlobNow(blob, sidHint));
    this.blobWrites = write.catch(() => undefined);
    return write;
  }

  /**
   * One transaction: skip a blob the session already tracks, otherwise store it (or count one
   * more reference to the stored copy) and track it for the session under `[sid, hash]`.
   */
  private async putBlobNow(blob: StoredBlob, sidHint?: string): Promise<void> {
    const trackingSid = normalizeTrackingSid(sidHint);
    const refKey: BlobRefRow["key"] | null =
      trackingSid && SHA256_HEX_PATTERN.test(blob.hash) ? [trackingSid, blob.hash] : null;

    await this.writeWithQuotaRecovery(
      ["blobs", "blobRefs"],
      async (transaction) => {
        const blobs = transaction.objectStore("blobs");
        const refs = transaction.objectStore("blobRefs");

        if (refKey && (await requestToPromise(refs.getKey(refKey))) !== undefined) {
          return;
        }

        const existing = (await requestToPromise<BlobRow | undefined>(blobs.get(blob.hash)))?.value;
        const row: BlobRow = {
          key: blob.hash,
          value: existing ? { ...existing, refCount: existing.refCount + 1 } : blob
        };

        blobs.put(row);

        if (refKey) {
          refs.put(createBlobRefRow(refKey, existing ?? blob));
        }
      },
      {
        allowQuotaRecovery: true,
        protectedSid: sidHint
      }
    );
  }

  public async getBlob(hash: string): Promise<StoredBlob | undefined> {
    const row = await this.get<BlobRow>("blobs", hash);
    return row?.value;
  }

  public async listBlobs(): Promise<StoredBlob[]> {
    const rows = await this.getAll<BlobRow>("blobs");
    return rows.map((row) => row.value);
  }

  public async listSessionBlobInfo(sid: string): Promise<StoredBlobInfo[]> {
    const db = await this.db();
    const rows = await runTransaction(db, "blobRefs", "readonly", (store) =>
      requestToPromise<BlobRefRow[]>(store.getAll(blobRefRange(sid)))
    );

    return rows.map(({ hash, mime, size }) => ({ hash, mime, size }));
  }

  public async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    await this.put<IndexRow>(
      "indexes",
      {
        key: sid,
        value: indexes
      },
      {
        allowQuotaRecovery: true,
        protectedSid: sid
      }
    );
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    const row = await this.get<IndexRow>("indexes", sid);
    return row?.value ?? EMPTY_INDEXES;
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    await this.put<IntegrityRow>(
      "integrity",
      {
        key: sid,
        value: manifest
      },
      {
        allowQuotaRecovery: true,
        protectedSid: sid
      }
    );
  }

  public async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    const row = await this.get<IntegrityRow>("integrity", sid);
    return row?.value;
  }

  public async deleteSession(sid: string, blobHashes: string[] = []): Promise<void> {
    const trackedBlobHashes = await this.getTrackedBlobHashes(sid);
    const mergedBlobHashes = mergeBlobHashes(blobHashes, trackedBlobHashes);
    const db = await this.db();

    await runTransaction(db, "sessions", "readwrite", (store) => {
      return requestToPromise(store.delete(sid));
    });
    await runTransaction(db, "indexes", "readwrite", (store) => {
      return requestToPromise(store.delete(sid));
    });
    await runTransaction(db, "integrity", "readwrite", (store) => {
      return requestToPromise(store.delete(sid));
    });
    await this.deleteChunksBySid(sid);
    await this.deleteTrackedBlobHashes(sid);

    for (const hash of mergedBlobHashes) {
      await this.decrementOrDeleteBlob(hash);
    }
  }

  private chunkKey(sid: string, chunkId: string): string {
    return `${sid}:${chunkId}`;
  }

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.open();
    }

    return this.dbPromise;
  }

  private put<TRow>(
    storeName: string,
    value: TRow,
    options: {
      allowQuotaRecovery?: boolean;
      protectedSid?: string;
    } = {}
  ): Promise<void> {
    return this.writeWithQuotaRecovery(
      [storeName],
      (transaction) => {
        transaction.objectStore(storeName).put(value);
      },
      options
    );
  }

  /** Runs a write transaction; on a quota error, evicts the oldest session and retries. */
  private async writeWithQuotaRecovery(
    storeNames: string[],
    write: (transaction: IDBTransaction) => void | Promise<void>,
    options: {
      allowQuotaRecovery?: boolean;
      protectedSid?: string;
    }
  ): Promise<void> {
    const recoveryAttempts = options.allowQuotaRecovery === true ? MAX_QUOTA_RECOVERY_ATTEMPTS : 0;
    let attempt = 0;

    while (true) {
      const db = await this.db();

      try {
        await runStoresTransaction(db, storeNames, "readwrite", write);
        return;
      } catch (error) {
        if (!isQuotaExceededError(error) || attempt >= recoveryAttempts) {
          throw error;
        }

        attempt += 1;

        const recovered = await this.recoverQuotaPressure(options.protectedSid);

        if (!recovered) {
          throw error;
        }
      }
    }
  }

  private async get<TRow>(storeName: string, key: string): Promise<TRow | undefined> {
    const db = await this.db();

    return runTransaction(db, storeName, "readonly", (store) => {
      return requestToPromise<TRow | undefined>(store.get(key));
    });
  }

  private async getAll<TRow>(storeName: string): Promise<TRow[]> {
    const db = await this.db();

    return runTransaction(db, storeName, "readonly", (store) => {
      return requestToPromise<TRow[]>(store.getAll());
    });
  }

  private async recoverQuotaPressure(protectedSid?: string): Promise<boolean> {
    const before = await getNavigatorStorageEstimate();
    const evictedSid = await this.evictOldestSession(protectedSid);

    if (!evictedSid) {
      console.warn(
        "[WebBlackbox] IndexedDB quota pressure detected, no evictable sessions remain",
        {
          protectedSid,
          usage: before?.usage ?? null,
          quota: before?.quota ?? null
        }
      );
      return false;
    }

    const after = await getNavigatorStorageEstimate();

    console.warn("[WebBlackbox] IndexedDB quota pressure detected, evicted oldest session", {
      evictedSid,
      protectedSid,
      usageBefore: before?.usage ?? null,
      usageAfter: after?.usage ?? null,
      quota: after?.quota ?? before?.quota ?? null
    });

    return true;
  }

  private async evictOldestSession(protectedSid?: string): Promise<string | null> {
    const rows = await this.getAll<SessionRow>("sessions");
    const candidates = rows
      .map((row) => row.value)
      .filter((session) => session.sid !== protectedSid)
      .sort((left, right) => left.startedAt - right.startedAt);
    const oldest = candidates[0];

    if (!oldest) {
      return null;
    }

    await this.deleteSessionWithBlobCleanup(oldest.sid);
    return oldest.sid;
  }

  private async deleteSessionWithBlobCleanup(sid: string): Promise<void> {
    const blobHashes = await this.resolveBlobHashesForSession(sid);
    await this.deleteSession(sid, blobHashes);
  }

  private open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) {
      return Promise.reject(new Error("indexedDB is unavailable in this runtime"));
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;

        for (const storeName of [
          "sessions",
          "chunks",
          "blobs",
          "blobRefs",
          "indexes",
          "integrity"
        ]) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "key" });
          }
        }

        const transaction = request.transaction;
        const chunksStore = transaction?.objectStore("chunks");

        if (chunksStore && !chunksStore.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
          chunksStore.createIndex(CHUNKS_BY_SID_SEQ_INDEX, ["sid", "seq"], { unique: false });
        }

        if (
          transaction &&
          event.oldVersion > 0 &&
          event.oldVersion < BLOB_REFS_KEYED_BY_SID_HASH_VERSION
        ) {
          migrateLegacyBlobRefs(transaction);
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        // Lets a deleteDatabase() elsewhere (the extension's restart purge) proceed instead of
        // blocking on this connection; the next operation reopens the database.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        reject(request.error ?? new Error("Failed to open IndexedDB"));
      };
    });
  }

  private async deleteChunksBySid(sid: string): Promise<void> {
    const db = await this.db();

    await runTransaction(db, "chunks", "readwrite", (store) => {
      if (store.indexNames.contains(CHUNKS_BY_SID_SEQ_INDEX)) {
        const index = store.index(CHUNKS_BY_SID_SEQ_INDEX);
        const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
        return deleteByCursor(index.openCursor(range));
      }

      return requestToPromise<ChunkRow[]>(store.getAll()).then(async (rows) => {
        for (const row of rows) {
          if (row.value.sid !== sid) {
            continue;
          }

          await requestToPromise(store.delete(row.key));
        }
      });
    });
  }

  private async resolveBlobHashesForSession(sid: string): Promise<string[]> {
    const tracked = await this.getTrackedBlobHashes(sid);

    if (tracked.length > 0) {
      return tracked;
    }

    const hashes = new Set<string>();

    for (const meta of await this.listChunkMetas(sid)) {
      const chunk = await this.getChunk(sid, meta.chunkId);

      if (chunk) {
        await collectBlobHashesFromChunk(chunk, hashes);
      }
    }

    return [...hashes];
  }

  private async getTrackedBlobHashes(sid: string): Promise<string[]> {
    const db = await this.db();
    const keys = await runTransaction(db, "blobRefs", "readonly", (store) =>
      requestToPromise(store.getAllKeys(blobRefRange(sid)))
    );

    return normalizeBlobHashes(keys.map((key) => (key as BlobRefRow["key"])[1]));
  }

  private async deleteTrackedBlobHashes(sid: string): Promise<void> {
    const db = await this.db();
    await runTransaction(db, "blobRefs", "readwrite", (store) => {
      return requestToPromise(store.delete(blobRefRange(sid)));
    });
  }

  private async decrementOrDeleteBlob(hash: string): Promise<void> {
    const existing = await this.getBlob(hash);

    if (!existing) {
      return;
    }

    if (existing.refCount <= 1) {
      const db = await this.db();
      await runTransaction(db, "blobs", "readwrite", (store) => {
        return requestToPromise(store.delete(hash));
      });
      return;
    }

    await this.put<BlobRow>(
      "blobs",
      {
        key: hash,
        value: {
          ...existing,
          refCount: existing.refCount - 1
        }
      },
      {
        allowQuotaRecovery: false
      }
    );
  }
}

function createBlobRefRow(
  key: BlobRefRow["key"],
  blob: Pick<StoredBlob, "mime" | "size">
): BlobRefRow {
  return { key, sid: key[0], hash: key[1], mime: blob.mime, size: blob.size };
}

/** Every `[sid, hash]` key of one session: arrays sort after strings, `[]` after any hash. */
function blobRefRange(sid: string): IDBKeyRange {
  return IDBKeyRange.bound([sid], [sid, []]);
}

/**
 * Version 4 upgrade: each legacy `{ key: sid, value: hashes[] }` row becomes one row per
 * tracked blob, with the blob's type and size read from the blob store.
 */
function migrateLegacyBlobRefs(transaction: IDBTransaction): void {
  const refs = transaction.objectStore("blobRefs");
  const blobs = transaction.objectStore("blobs");
  const cursorRequest = refs.openCursor();

  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;

    if (!cursor) {
      return;
    }

    const row = cursor.value as Partial<LegacyBlobRefsRow>;

    if (typeof row.key === "string" && Array.isArray(row.value)) {
      const sid = row.key;

      for (const hash of normalizeBlobHashes(row.value)) {
        const blobRequest = blobs.get(hash);

        blobRequest.onsuccess = () => {
          const blob = (blobRequest.result as BlobRow | undefined)?.value;

          if (blob) {
            refs.put(createBlobRefRow([sid, hash], blob));
          }
        };
      }

      cursor.delete();
    }

    cursor.continue();
  };
}

function isQuotaExceededError(error: unknown): boolean {
  const DomException = globalThis.DOMException;

  if (!DomException || !(error instanceof DomException)) {
    return false;
  }

  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

async function getNavigatorStorageEstimate(): Promise<{ usage?: number; quota?: number } | null> {
  const estimate = globalThis.navigator?.storage?.estimate;

  if (typeof estimate !== "function") {
    return null;
  }

  try {
    const value = await estimate.call(globalThis.navigator.storage);
    return {
      usage: typeof value.usage === "number" ? value.usage : undefined,
      quota: typeof value.quota === "number" ? value.quota : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Blob hashes referenced by one stored chunk, decoded with the chunk's codec. Chunks this
 * storage cannot decode (sealed by an encrypting wrapper) reference nothing it can find.
 */
async function collectBlobHashesFromChunk(chunk: StoredChunk, output: Set<string>): Promise<void> {
  try {
    for (const event of await decodeChunkEvents(chunk.bytes, chunk.meta.codec)) {
      collectBlobHashesFromUnknown(event.data, output);
    }
  } catch {
    return;
  }
}

function normalizeBlobHashes(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const output = new Set<string>();

  for (const value of values) {
    if (typeof value === "string" && SHA256_HEX_PATTERN.test(value)) {
      output.add(value);
    }
  }

  return [...output];
}

function mergeBlobHashes(...sources: unknown[]): string[] {
  const output = new Set<string>();

  for (const source of sources) {
    for (const hash of normalizeBlobHashes(source)) {
      output.add(hash);
    }
  }

  return [...output];
}

function normalizeTrackingSid(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function runTransaction<TResult>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => TResult | Promise<TResult>
): Promise<TResult> {
  return runStoresTransaction(db, [storeName], mode, (transaction) =>
    handler(transaction.objectStore(storeName))
  );
}

async function runStoresTransaction<TResult>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  handler: (transaction: IDBTransaction) => TResult | Promise<TResult>
): Promise<TResult> {
  const transaction = db.transaction(storeNames, mode);
  const result = await handler(transaction);

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });

  return result;
}

function requestToPromise<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function deleteByCursor(request: IDBRequest<IDBCursorWithValue | null>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB cursor iteration failed"));
    };

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      cursor.continue();
    };
  });
}

function collectCursorValues<TRow, TResult>(
  request: IDBRequest<IDBCursorWithValue | null>,
  pick: (row: TRow) => TResult | null
): Promise<TResult[]> {
  const output: TResult[] = [];

  return new Promise<TResult[]>((resolve, reject) => {
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB cursor iteration failed"));
    };

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) {
        resolve(output);
        return;
      }

      const value = pick(cursor.value as TRow);

      if (value !== null) {
        output.push(value);
      }

      cursor.continue();
    };
  });
}

function firstCursorValue<TResult>(
  request: IDBRequest<IDBCursorWithValue | null>
): Promise<TResult | undefined> {
  return new Promise<TResult | undefined>((resolve, reject) => {
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB cursor iteration failed"));
    };

    request.onsuccess = () => {
      const cursor = request.result;
      resolve((cursor?.value as TResult | undefined) ?? undefined);
    };
  });
}
