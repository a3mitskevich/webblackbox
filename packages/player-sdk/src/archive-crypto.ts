export async function deriveArchiveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
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
      salt: toArrayBuffer(salt)
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["decrypt"]
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;

  if (subtle) {
    const digest = await subtle.digest("SHA-256", toArrayBuffer(bytes));
    const output = new Uint8Array(digest);
    let hex = "";

    for (const value of output) {
      hex += value.toString(16).padStart(2, "0");
    }

    return hex;
  }

  const fromNode = await sha256HexWithNodeCrypto(bytes);

  if (fromNode) {
    return fromNode;
  }

  throw new Error("Web Crypto API or Node crypto is required for SHA-256 hashing.");
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
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(bytes)
  );

  return new Uint8Array(decrypted);
}

export function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required to open encrypted archives.");
}

let nodeCryptoPromise: Promise<typeof import("node:crypto") | null> | null = null;

async function sha256HexWithNodeCrypto(bytes: Uint8Array): Promise<string | null> {
  const runtime = globalThis as typeof globalThis & {
    process?: {
      versions?: {
        node?: string;
      };
    };
  };

  if (!runtime.process?.versions?.node) {
    return null;
  }

  nodeCryptoPromise ??= import("node:crypto").catch(() => null);
  const nodeCrypto = await nodeCryptoPromise;

  if (!nodeCrypto) {
    return null;
  }

  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
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

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
