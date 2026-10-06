/** AES-GCM, PBKDF2 and base64 helpers shared by the archive writer and reader. */

/** AES-GCM nonce length used for every encrypted archive file. */
export const AES_GCM_IV_BYTES = 12;

/** AES-GCM authentication tag length: ciphertext is this much longer than the plaintext. */
export const AES_GCM_TAG_BYTES = 16;

export async function deriveArchiveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: "encrypt" | "decrypt"
): Promise<CryptoKey> {
  const cryptoApi = requireCryptoApi();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: toBufferSource(salt)
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    [usage]
  );
}

export async function encryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const encrypted = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(iv)
    },
    key,
    toBufferSource(bytes)
  );

  return new Uint8Array(encrypted);
}

export async function decryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const decrypted = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(iv)
    },
    key,
    toBufferSource(bytes)
  );

  return new Uint8Array(decrypted);
}

export function randomBytes(size: number): Uint8Array {
  const cryptoApi = requireCryptoApi();
  const bytes = new Uint8Array(size);
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

export function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required for archive encryption.");
}

/**
 * The bytes as a Web Crypto input: a view over an ordinary `ArrayBuffer` is passed as it is
 * (archive files can be tens of MB, so no defensive copy); a view over a shared buffer is copied.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  throw new Error("Base64 encoding is unavailable in this environment.");
}

export function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  throw new Error("Base64 decoding is unavailable in this environment.");
}
