import {
  EncryptedPipelineStorage,
  importPipelineStorageKey,
  IndexedDbPipelineStorage,
  type PipelineStorage,
  type UnreadableSessionPurgeResult
} from "@webblackbox/pipeline";

import { base64ToBytes, PIPELINE_DB_NAME, type StorageKeyMessage } from "../shared/at-rest.js";

const DEFAULT_KEY_TIMEOUT_MS = 10_000;

export type AtRestStorageProviderOptions = {
  createInnerStorage?: () => PipelineStorage;
  importKey?: (raw: Uint8Array) => Promise<CryptoKey>;
  keyTimeoutMs?: number;
  onPurged?: (result: UnreadableSessionPurgeResult) => void;
  onPurgeError?: (error: unknown) => void;
};

export type AtRestStorageProvider = {
  /** Installs this browser session's key; the first one also purges unreadable sessions. */
  acceptKey(message: StorageKeyMessage): Promise<void>;
  /** The encrypted pipeline storage, once the service worker has sent the key. */
  getStorage(): Promise<PipelineStorage>;
};

/**
 * Builds the offscreen pipeline's storage: IndexedDB wrapped in AES-GCM with the key the service
 * worker hands over. The raw key bytes are zeroed right after the non-extractable import. Before
 * the storage is used, sessions the key cannot open (another browser session's key, or plaintext
 * rows from before encryption) are deleted: they are unrecoverable by design.
 */
export function createAtRestStorageProvider(
  options: AtRestStorageProviderOptions = {}
): AtRestStorageProvider {
  const createInnerStorage =
    options.createInnerStorage ?? (() => new IndexedDbPipelineStorage(PIPELINE_DB_NAME));
  const importKey = options.importKey ?? importPipelineStorageKey;
  const keyTimeoutMs = options.keyTimeoutMs ?? DEFAULT_KEY_TIMEOUT_MS;
  let active: { keyId: string; storage: Promise<PipelineStorage> } | null = null;
  let markKeyReceived: () => void = () => undefined;
  const keyReceived = new Promise<void>((resolve) => {
    markKeyReceived = resolve;
  });

  const openStorage = async (raw: Uint8Array): Promise<PipelineStorage> => {
    let key: CryptoKey;

    try {
      key = await importKey(raw);
    } finally {
      raw.fill(0);
    }

    const storage = new EncryptedPipelineStorage(createInnerStorage(), { key });

    try {
      // Not inlined into `onPurged?.(...)`: an optional call skips its arguments when absent.
      const purged = await storage.purgeUnreadableSessions();
      options.onPurged?.(purged);
    } catch (error) {
      options.onPurgeError?.(error);
    }

    return storage;
  };

  return {
    async acceptKey(message) {
      if (active?.keyId !== message.keyId) {
        active = { keyId: message.keyId, storage: openStorage(base64ToBytes(message.key)) };
        markKeyReceived();
      }

      await active.storage;
    },

    async getStorage() {
      await withTimeout(
        keyReceived,
        keyTimeoutMs,
        "The at-rest encryption key was not received from the service worker."
      );

      if (!active) {
        throw new Error("The at-rest encryption key is unavailable.");
      }

      return active.storage;
    }
  };
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
