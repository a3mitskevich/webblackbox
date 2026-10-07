import type { ChunkTimeIndexEntry, HashesManifest, SessionMetadata } from "@webblackbox/protocol";

import type {
  PipelineStorage,
  StoredBlob,
  StoredBlobInfo,
  StoredChunk,
  StoredIndexes
} from "./storage.js";
import {
  decryptStorageBytes,
  encryptStorageBytes,
  looksEncryptedStorageBytes,
  openStorageRecord,
  randomBytes,
  requireCryptoApi,
  sealStorageRecord,
  toArrayBuffer
} from "./storage-crypto.js";

const STORAGE_ENCRYPTION_KDF_ITERATIONS = 120_000;

export type PipelineStorageKeyOptions = {
  salt?: Uint8Array;
  iterations?: number;
};

export type DerivedPipelineStorageKey = {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
};

export type EncryptedPipelineStorageOptions = {
  key: CryptoKey | Promise<CryptoKey>;
};

export type UnreadableSessionPurgeResult = {
  deleted: string[];
  failed: Array<{ sid: string; error: string }>;
};

/** Ciphertext of a whole record, stored next to the record's placeholder fields. */
type SealedRecord = {
  sealed: Uint8Array;
};

/**
 * Derives an AES-GCM key for at-rest pipeline storage encryption.
 * Persist the returned salt to derive the same key for future reads.
 */
export async function derivePipelineStorageKey(
  passphrase: string,
  options: PipelineStorageKeyOptions = {}
): Promise<DerivedPipelineStorageKey> {
  const iterations = normalizePositiveInt(options.iterations, STORAGE_ENCRYPTION_KDF_ITERATIONS);
  const salt = options.salt ? Uint8Array.from(options.salt) : randomBytes(16);
  const cryptoApi = requireCryptoApi();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: toArrayBuffer(salt)
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );

  return {
    key,
    salt,
    iterations
  };
}

/**
 * PipelineStorage wrapper that encrypts everything it writes with AES-GCM: chunk and blob bytes,
 * and whole session, index and integrity records. A sealed record keeps its row shape so any
 * inner storage can persist it; only opaque ids, the mode and timestamps stay readable (quota
 * eviction and sweeps order sessions by `startedAt`). Unsealed rows written before encryption
 * are still read as they are.
 */
export class EncryptedPipelineStorage implements PipelineStorage {
  private readonly keyPromise: Promise<CryptoKey>;

  public constructor(
    private readonly storage: PipelineStorage,
    options: EncryptedPipelineStorageOptions
  ) {
    this.keyPromise = Promise.resolve(options.key);
  }

  public async putSession(metadata: SessionMetadata): Promise<void> {
    const row: SessionMetadata & SealedRecord = {
      sid: metadata.sid,
      tabId: metadata.tabId,
      startedAt: metadata.startedAt,
      mode: metadata.mode,
      url: "",
      tags: [],
      sealed: await sealStorageRecord(
        await this.keyPromise,
        metadata,
        sessionRecordAad(metadata.sid)
      )
    };

    await this.storage.putSession(row);
  }

  public async getSession(sid: string): Promise<SessionMetadata | undefined> {
    const row = await this.storage.getSession(sid);
    return row ? this.openSession(row) : undefined;
  }

  /** Sessions this key cannot open are listed with their readable placeholder fields only. */
  public async listSessions(): Promise<SessionMetadata[]> {
    const rows = await this.listStoredSessions();

    return Promise.all(
      rows.map((row) => this.openSession(row).catch(() => withoutSealedRecord(row)))
    );
  }

  /**
   * Deletes every stored session this key cannot open: rows sealed with another key (a
   * previous browser session) and plaintext rows written before encryption. Their chunks,
   * indexes and tracked blobs go with them. A failing delete is reported, not thrown.
   */
  public async purgeUnreadableSessions(): Promise<UnreadableSessionPurgeResult> {
    const rows = await this.listStoredSessions();
    const result: UnreadableSessionPurgeResult = { deleted: [], failed: [] };

    for (const row of rows) {
      if (await this.canOpenSession(row)) {
        continue;
      }

      try {
        await this.storage.deleteSession(row.sid);
        result.deleted.push(row.sid);
      } catch (error) {
        result.failed.push({
          sid: row.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return result;
  }

  public async putChunk(chunk: StoredChunk): Promise<void> {
    await this.storage.putChunk({
      ...chunk,
      bytes: await this.encryptStoredBytes(chunk.bytes)
    });
  }

  public async listChunks(sid: string): Promise<StoredChunk[]> {
    const chunks = await this.storage.listChunks(sid);
    return Promise.all(
      chunks.map(async (chunk) => {
        return {
          ...chunk,
          bytes: await this.decryptStoredBytes(chunk.bytes)
        };
      })
    );
  }

  public async getLatestChunkMeta(sid: string): Promise<ChunkTimeIndexEntry | undefined> {
    return this.storage.getLatestChunkMeta(sid);
  }

  public async getChunk(sid: string, chunkId: string): Promise<StoredChunk | undefined> {
    const chunk = await this.storage.getChunk(sid, chunkId);

    if (!chunk) {
      return undefined;
    }

    return {
      ...chunk,
      bytes: await this.decryptStoredBytes(chunk.bytes)
    };
  }

  /** Chunk metadata is stored readable; only the bytes are encrypted. */
  public async listChunkMetas(sid: string): Promise<ChunkTimeIndexEntry[]> {
    if (this.storage.listChunkMetas) {
      return this.storage.listChunkMetas(sid);
    }

    return (await this.storage.listChunks(sid)).map((chunk) => chunk.meta);
  }

  public async putBlob(blob: StoredBlob, sidHint?: string): Promise<void> {
    await this.storage.putBlob(
      {
        ...blob,
        bytes: await this.encryptStoredBytes(blob.bytes)
      },
      sidHint
    );
  }

  public async getBlob(hash: string): Promise<StoredBlob | undefined> {
    const blob = await this.storage.getBlob(hash);

    if (!blob) {
      return undefined;
    }

    return {
      ...blob,
      bytes: await this.decryptStoredBytes(blob.bytes)
    };
  }

  public async listBlobs(): Promise<StoredBlob[]> {
    const blobs = await this.storage.listBlobs();
    return Promise.all(
      blobs.map(async (blob) => {
        return {
          ...blob,
          bytes: await this.decryptStoredBytes(blob.bytes)
        };
      })
    );
  }

  /** Blob type and plaintext size stay readable in the wrapped storage, like the hash. */
  public async listSessionBlobInfo(sid: string): Promise<StoredBlobInfo[]> {
    return (await this.storage.listSessionBlobInfo?.(sid)) ?? [];
  }

  public async putIndexes(sid: string, indexes: StoredIndexes): Promise<void> {
    const row: StoredIndexes & SealedRecord = {
      time: [],
      request: [],
      inverted: [],
      sealed: await sealStorageRecord(await this.keyPromise, indexes, indexesRecordAad(sid))
    };

    await this.storage.putIndexes(sid, row);
  }

  public async getIndexes(sid: string): Promise<StoredIndexes> {
    const row = await this.storage.getIndexes(sid);

    if (!hasSealedRecord(row)) {
      return row;
    }

    const opened = await openStorageRecord(
      await this.keyPromise,
      row.sealed,
      indexesRecordAad(sid)
    );

    if (!isStoredIndexes(opened)) {
      throw new Error("Stored pipeline indexes are malformed.");
    }

    return opened;
  }

  public async putIntegrity(sid: string, manifest: HashesManifest): Promise<void> {
    const row: HashesManifest & SealedRecord = {
      manifestSha256: "",
      files: {},
      sealed: await sealStorageRecord(await this.keyPromise, manifest, integrityRecordAad(sid))
    };

    await this.storage.putIntegrity(sid, row);
  }

  public async getIntegrity(sid: string): Promise<HashesManifest | undefined> {
    const row = await this.storage.getIntegrity(sid);

    if (!row || !hasSealedRecord(row)) {
      return row;
    }

    const opened = await openStorageRecord(
      await this.keyPromise,
      row.sealed,
      integrityRecordAad(sid)
    );

    if (!isHashesManifest(opened)) {
      throw new Error("Stored pipeline integrity manifest is malformed.");
    }

    return opened;
  }

  public async deleteSession(sid: string, blobHashes?: string[]): Promise<void> {
    await this.storage.deleteSession(sid, blobHashes);
  }

  private async listStoredSessions(): Promise<SessionMetadata[]> {
    if (!this.storage.listSessions) {
      throw new Error("Wrapped pipeline storage does not support listing sessions.");
    }

    return this.storage.listSessions();
  }

  private async openSession(row: SessionMetadata): Promise<SessionMetadata> {
    if (!hasSealedRecord(row)) {
      return row;
    }

    const opened = await openStorageRecord(
      await this.keyPromise,
      row.sealed,
      sessionRecordAad(row.sid)
    );

    if (!isSessionMetadataFor(opened, row.sid)) {
      throw new Error("Stored pipeline session metadata is malformed.");
    }

    return opened;
  }

  private async canOpenSession(row: SessionMetadata): Promise<boolean> {
    if (!hasSealedRecord(row)) {
      return false;
    }

    try {
      await this.openSession(row);
      return true;
    } catch {
      return false;
    }
  }

  private async encryptStoredBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return encryptStorageBytes(await this.keyPromise, bytes);
  }

  private async decryptStoredBytes(bytes: Uint8Array): Promise<Uint8Array> {
    if (!looksEncryptedStorageBytes(bytes)) {
      return bytes;
    }

    return decryptStorageBytes(await this.keyPromise, bytes);
  }
}

function sessionRecordAad(sid: string): string {
  return `webblackbox:session:${sid}`;
}

function indexesRecordAad(sid: string): string {
  return `webblackbox:indexes:${sid}`;
}

function integrityRecordAad(sid: string): string {
  return `webblackbox:integrity:${sid}`;
}

function hasSealedRecord<TRecord extends object>(
  record: TRecord
): record is TRecord & SealedRecord {
  return "sealed" in record && record.sealed instanceof Uint8Array;
}

function withoutSealedRecord(row: SessionMetadata): SessionMetadata {
  return {
    sid: row.sid,
    tabId: row.tabId,
    startedAt: row.startedAt,
    mode: row.mode,
    url: row.url,
    tags: [...row.tags]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSessionMetadataFor(value: unknown, sid: string): value is SessionMetadata {
  return (
    isRecord(value) &&
    value.sid === sid &&
    typeof value.tabId === "number" &&
    typeof value.startedAt === "number" &&
    (value.mode === "lite" || value.mode === "full") &&
    typeof value.url === "string" &&
    Array.isArray(value.tags)
  );
}

function isStoredIndexes(value: unknown): value is StoredIndexes {
  return (
    isRecord(value) &&
    Array.isArray(value.time) &&
    Array.isArray(value.request) &&
    Array.isArray(value.inverted)
  );
}

function isHashesManifest(value: unknown): value is HashesManifest {
  return isRecord(value) && typeof value.manifestSha256 === "string" && isRecord(value.files);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}
