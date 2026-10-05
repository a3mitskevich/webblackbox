import {
  bytesToBase64,
  bytesToHex,
  isBase64Key,
  isKeyId,
  STORAGE_KEY_BYTES,
  STORAGE_KEY_MESSAGE_KIND,
  type StorageKeyMessage
} from "../shared/at-rest.js";

/**
 * The per-browser-session key that encrypts the pipeline IndexedDB. It lives only in
 * `chrome.storage.session`, which Chrome keeps in memory and clears when the browser exits or the
 * extension reloads, so it is never written to disk. A `CryptoKey` cannot be stored there or sent
 * over extension messaging (both are JSON), so the raw bytes are kept and the offscreen document
 * imports them as a non-extractable key.
 */
export const AT_REST_KEY_STORAGE_KEY = "webblackbox.atRest.sessionKey";
const KEY_ID_BYTES = 8;

export type AtRestKeyRecord = {
  keyId: string;
  /** Base64 of the 32 raw key bytes. */
  key: string;
  createdAt: number;
};

export type AtRestKeyState = {
  record: AtRestKeyRecord;
  /** A new key: anything already stored was written under a lost key and is unreadable. */
  fresh: boolean;
};

export type SessionStorageAreaLike = {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
};

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

const defaultRandomFill: RandomFill = (bytes) => crypto.getRandomValues(bytes);

export function parseAtRestKeyRecord(value: unknown): AtRestKeyRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;

  if (
    !isKeyId(row.keyId) ||
    !isBase64Key(row.key) ||
    typeof row.createdAt !== "number" ||
    !Number.isFinite(row.createdAt)
  ) {
    return null;
  }

  return { keyId: row.keyId, key: row.key, createdAt: row.createdAt };
}

export function createAtRestKeyRecord(
  now: number,
  randomFill: RandomFill = defaultRandomFill
): AtRestKeyRecord {
  return {
    keyId: bytesToHex(randomFill(new Uint8Array(KEY_ID_BYTES))),
    key: bytesToBase64(randomFill(new Uint8Array(STORAGE_KEY_BYTES))),
    createdAt: now
  };
}

/** Reads this browser session's key, or mints and stores one when there is none (yet). */
export async function loadOrCreateAtRestKey(
  area: SessionStorageAreaLike | undefined,
  options: { now?: () => number; randomFill?: RandomFill } = {}
): Promise<AtRestKeyState> {
  if (!area) {
    throw new Error("chrome.storage.session is unavailable: recordings cannot be encrypted.");
  }

  const values = await area.get(AT_REST_KEY_STORAGE_KEY);
  const existing = parseAtRestKeyRecord(values?.[AT_REST_KEY_STORAGE_KEY]);

  if (existing) {
    return { record: existing, fresh: false };
  }

  const record = createAtRestKeyRecord(
    (options.now ?? Date.now)(),
    options.randomFill ?? defaultRandomFill
  );
  await area.set({ [AT_REST_KEY_STORAGE_KEY]: record });
  return { record, fresh: true };
}

export type AtRestKeyBootstrap = AtRestKeyState & {
  /** `"kept"`: the key was restored, so the stored recordings are still readable. */
  database: "deleted" | "blocked" | "unavailable" | "kept";
};

/**
 * Readies at-rest storage when a service worker instance starts: pins `storage.session`, then loads
 * the key or mints one. A minted key means a new browser session (or an extension reload): what
 * the pipeline database holds was written under a lost key, so the database is deleted before any
 * offscreen document can open it. A restored key means only the worker restarted (Chrome stops
 * idle workers); the recordings stay readable and are kept until the browser closes or their
 * retention ends. Rows written under another key are purged by the offscreen document.
 */
export async function bootstrapAtRestKey(
  area: SessionStorageAreaLike | undefined,
  indexedDb: IDBFactory | undefined,
  dbName: string,
  options: { onAccessLevelError?: (error: unknown) => void } = {}
): Promise<AtRestKeyBootstrap> {
  await restrictSessionStorageAccess(area).catch((error: unknown) => {
    options.onAccessLevelError?.(error);
  });

  const state = await loadOrCreateAtRestKey(area);
  const database = state.fresh ? await deletePipelineDatabase(indexedDb, dbName) : "kept";

  return { ...state, database };
}

/**
 * Pins `chrome.storage.session` to trusted extension contexts. That is Chrome's default; setting
 * it explicitly keeps a future `setAccessLevel` call elsewhere from exposing the key to content
 * scripts unnoticed.
 */
export async function restrictSessionStorageAccess(
  area: SessionStorageAreaLike | undefined
): Promise<void> {
  await area?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
}

export function toStorageKeyMessage(record: AtRestKeyRecord): StorageKeyMessage {
  return { kind: STORAGE_KEY_MESSAGE_KIND, keyId: record.keyId, key: record.key };
}

/**
 * Only the extension's own offscreen document may hold the offscreen port, which carries the key
 * and every recorded event: no tab, exact URL.
 */
export function isOffscreenDocumentPort(
  port: { sender?: { url?: string; tab?: unknown } },
  offscreenUrl: string
): boolean {
  return port.sender?.tab === undefined && port.sender?.url === offscreenUrl;
}

/**
 * Deletes the pipeline database. Resolves `"blocked"` when an open connection holds it: the
 * deletion stays queued, completes once that connection closes, and any later open waits for it.
 */
export function deletePipelineDatabase(
  factory: IDBFactory | undefined,
  name: string
): Promise<"deleted" | "blocked" | "unavailable"> {
  if (!factory) {
    return Promise.resolve("unavailable");
  }

  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);

    request.onsuccess = () => resolve("deleted");
    request.onblocked = () => resolve("blocked");
    request.onerror = () =>
      reject(request.error ?? new Error(`Failed to delete IndexedDB database ${name}.`));
  });
}
