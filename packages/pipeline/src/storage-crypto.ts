/**
 * AES-GCM primitives for at-rest pipeline storage. Encrypted bytes are framed as
 * `WBE1 | 12-byte IV | ciphertext+tag`; bytes without the magic are treated as legacy plaintext.
 */
const STORAGE_ENCRYPTION_MAGIC = new Uint8Array([0x57, 0x42, 0x45, 0x31]); // WBE1
const STORAGE_ENCRYPTION_IV_BYTES = 12;
const STORAGE_KEY_BYTES = 32;

/** Fresh random bytes for an AES-256-GCM storage key. Import them, then discard them. */
export function generatePipelineStorageKeyBytes(): Uint8Array {
  return randomBytes(STORAGE_KEY_BYTES);
}

/**
 * Imports raw key bytes as a non-extractable AES-GCM key: once imported, the key material
 * cannot be read back out of the `CryptoKey`.
 */
export async function importPipelineStorageKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== STORAGE_KEY_BYTES) {
    throw new Error(`Pipeline storage key must be ${STORAGE_KEY_BYTES} bytes.`);
  }

  return requireCryptoApi().subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptStorageBytes(
  key: CryptoKey,
  bytes: Uint8Array,
  additionalData?: string
): Promise<Uint8Array> {
  const iv = randomBytes(STORAGE_ENCRYPTION_IV_BYTES);
  const encrypted = await requireCryptoApi().subtle.encrypt(
    withAdditionalData({ name: "AES-GCM", iv: toArrayBuffer(iv) }, additionalData),
    key,
    toArrayBuffer(bytes)
  );

  return concatBytes(STORAGE_ENCRYPTION_MAGIC, iv, new Uint8Array(encrypted));
}

/** Decrypts framed bytes; throws when the key or the additional data does not match. */
export async function decryptStorageBytes(
  key: CryptoKey,
  bytes: Uint8Array,
  additionalData?: string
): Promise<Uint8Array> {
  const ivStart = STORAGE_ENCRYPTION_MAGIC.byteLength;
  const ivEnd = ivStart + STORAGE_ENCRYPTION_IV_BYTES;
  const params = withAdditionalData(
    { name: "AES-GCM", iv: toArrayBuffer(bytes.slice(ivStart, ivEnd)) },
    additionalData
  );

  try {
    const decrypted = await requireCryptoApi().subtle.decrypt(
      params,
      key,
      toArrayBuffer(bytes.slice(ivEnd))
    );

    return new Uint8Array(decrypted);
  } catch {
    throw new Error("Unable to decrypt pipeline storage payload.");
  }
}

export function looksEncryptedStorageBytes(bytes: Uint8Array): boolean {
  const minimumLength = STORAGE_ENCRYPTION_MAGIC.byteLength + STORAGE_ENCRYPTION_IV_BYTES + 1;

  if (bytes.byteLength < minimumLength) {
    return false;
  }

  return STORAGE_ENCRYPTION_MAGIC.every((value, index) => bytes[index] === value);
}

/** Encrypts a JSON value, bound to `additionalData` so it cannot be swapped into another row. */
export async function sealStorageRecord(
  key: CryptoKey,
  value: unknown,
  additionalData: string
): Promise<Uint8Array> {
  return encryptStorageBytes(key, new TextEncoder().encode(JSON.stringify(value)), additionalData);
}

export async function openStorageRecord(
  key: CryptoKey,
  sealed: Uint8Array,
  additionalData: string
): Promise<unknown> {
  if (!looksEncryptedStorageBytes(sealed)) {
    throw new Error("Unable to decrypt pipeline storage payload.");
  }

  const bytes = await decryptStorageBytes(key, sealed, additionalData);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required for pipeline storage encryption.");
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  requireCryptoApi().getRandomValues(bytes);
  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
}

function withAdditionalData(params: AesGcmParams, additionalData?: string): AesGcmParams {
  return additionalData === undefined
    ? params
    : { ...params, additionalData: toArrayBuffer(new TextEncoder().encode(additionalData)) };
}
