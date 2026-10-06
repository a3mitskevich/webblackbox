import type {
  ChunkTimeIndexEntry,
  HashesManifest,
  InvertedIndexEntry,
  RequestIndexEntry,
  SessionMetadata
} from "@webblackbox/protocol";

import { mergeBlobHashes, normalizeTrackingSid, SHA256_HEX_PATTERN } from "./blob-hashes.js";

// The IndexedDB storage and the encrypted wrapper live in their own modules; re-exported so
// existing imports keep working.
export * from "./encrypted-storage.js";
export * from "./indexeddb-storage.js";

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
