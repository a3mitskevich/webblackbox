/**
 * Shared contract for at-rest encryption of the offscreen pipeline's IndexedDB: the database
 * name and the message that hands the per-browser-session key from the service worker (the only
 * context with `chrome.storage.session`) to the offscreen document (which has only
 * `chrome.runtime`). Extension messaging is JSON, so the key travels as base64 raw bytes.
 */
export const PIPELINE_DB_NAME = "webblackbox-flight-recorder";
export const STORAGE_KEY_MESSAGE_KIND = "sw.storage-key";
export const STORAGE_KEY_BYTES = 32;

export type StorageKeyMessage = {
  kind: typeof STORAGE_KEY_MESSAGE_KIND;
  keyId: string;
  /** Base64 of the 32 raw key bytes. */
  key: string;
};

const KEY_ID_PATTERN = /^[a-f0-9]{16,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseStorageKeyMessage(value: unknown): StorageKeyMessage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;

  if (row.kind !== STORAGE_KEY_MESSAGE_KIND || !isKeyId(row.keyId) || !isBase64Key(row.key)) {
    return null;
  }

  return { kind: STORAGE_KEY_MESSAGE_KIND, keyId: row.keyId, key: row.key };
}

export function isKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_PATTERN.test(value);
}

export function isBase64Key(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    return false;
  }

  try {
    return base64ToBytes(value).byteLength === STORAGE_KEY_BYTES;
  } catch {
    return false;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
