import JSZip from "jszip";

import {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_KDF_DEFAULT_ITERATIONS,
  assertArchiveKdfIterations,
  assertExportPassphrase,
  ENCRYPTED_MANIFEST_PATH,
  inferBlobFileExtension,
  normalizeExportPassphrase
} from "@webblackbox/protocol";

import type {
  ArchiveEnvelopeManifest,
  ChunkCodec,
  ChunkTimeIndexEntry,
  ExportEncryption,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { decodeChunkEvents } from "./codec.js";
import { sha256Hex } from "./hash.js";
import type { StoredBlob, StoredChunk } from "./storage.js";

export type ExportBundleInput = {
  manifest: ExportManifest;
  chunks: StoredChunk[];
  blobs: StoredBlob[];
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  privacyManifest: PrivacyManifest;
};

export type ExportBundleOutput = {
  bytes: Uint8Array;
  integrity: HashesManifest;
};

export type ArchiveExportOptions = {
  /** Required: every archive is encrypted (at least 8 characters, trimmed). */
  passphrase?: string;
};

export type ArchiveReadOptions = {
  passphrase?: string;
};

const AES_GCM_IV_BYTES = 12;

export async function createWebBlackboxArchive(
  input: ExportBundleInput,
  options: ArchiveExportOptions = {}
): Promise<ExportBundleOutput> {
  // There is no plaintext export: the passphrase is checked here, below every caller.
  assertExportPassphrase(options.passphrase);

  const zip = new JSZip();
  const fileHashes: Record<string, string> = {};
  const encryption = await createArchiveEncryptionState(
    normalizeExportPassphrase(options.passphrase)
  );

  for (const chunk of input.chunks) {
    const path = `events/${chunk.meta.chunkId}.ndjson`;
    const bytes = await encryptForArchive(path, chunk.bytes, encryption);
    zip.file(path, bytes);
    fileHashes[path] = await sha256Hex(bytes);
  }

  await addJsonFile(zip, "index/time.json", input.timeIndex, fileHashes, encryption);
  await addJsonFile(zip, "index/req.json", input.requestIndex, fileHashes, encryption);
  await addJsonFile(zip, "index/inv.json", input.invertedIndex, fileHashes, encryption);
  await addJsonFile(zip, "privacy/manifest.json", input.privacyManifest, fileHashes, encryption);

  for (const blob of input.blobs) {
    const extension = inferBlobFileExtension(blob.mime);
    const path = `blobs/sha256-${blob.hash}.${extension}`;
    const bytes = await encryptForArchive(path, blob.bytes, encryption);
    zip.file(path, bytes);
    fileHashes[path] = await sha256Hex(bytes);
  }

  // Everything derived from the recording (site, mode, stats, redaction rules) is encrypted; the
  // plaintext envelope carries only what decryption needs. Written last: it lists every IV.
  await addJsonFile(zip, ENCRYPTED_MANIFEST_PATH, input.manifest, fileHashes, encryption);

  const envelope: ArchiveEnvelopeManifest = {
    protocolVersion: ARCHIVE_FORMAT_VERSION,
    encryption: encryption.meta
  };

  await addJsonFile(zip, "manifest.json", envelope, fileHashes);

  const manifestHash = fileHashes["manifest.json"] ?? "";
  const integrity: HashesManifest = {
    manifestSha256: manifestHash,
    files: {
      ...fileHashes
    }
  };

  zip.file("integrity/hashes.json", JSON.stringify(integrity, null, 2));

  // Ciphertext does not compress.
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });

  return {
    bytes,
    integrity
  };
}

export type ParsedWebBlackboxArchive = {
  manifest: ExportManifest;
  events: WebBlackboxEvent[];
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  privacyManifest: PrivacyManifest | null;
  integrity: HashesManifest | null;
};

export async function readWebBlackboxArchive(
  bytes: ArrayBuffer | Uint8Array,
  options: ArchiveReadOptions = {}
): Promise<ParsedWebBlackboxArchive> {
  const zip = await JSZip.loadAsync(bytes);
  const integrity = await readJson<HashesManifest>(zip, "integrity/hashes.json");

  await verifyArchiveIntegrity(zip, integrity);

  const envelope = await readJson<ExportManifest>(zip, "manifest.json");
  const archiveKey = await resolveArchiveReadKey(zip, envelope, options.passphrase);
  const manifest = await readFullManifest(zip, envelope, archiveKey);
  const timeIndex = await readArchiveJson<ChunkTimeIndexEntry[]>(
    zip,
    "index/time.json",
    manifest,
    archiveKey
  );
  const requestIndex = await readArchiveJson<RequestIndexEntry[]>(
    zip,
    "index/req.json",
    manifest,
    archiveKey
  );
  const invertedIndex = await readArchiveJson<InvertedIndexEntry[]>(
    zip,
    "index/inv.json",
    manifest,
    archiveKey
  );
  const privacyManifest = await readOptionalArchiveJson<PrivacyManifest>(
    zip,
    "privacy/manifest.json",
    manifest,
    archiveKey
  );

  const eventEntries = Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort();
  const chunkCodecById = new Map(timeIndex.map((entry) => [entry.chunkId, entry.codec] as const));

  const events: WebBlackboxEvent[] = [];

  for (const path of eventEntries) {
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const content = await file.async("uint8array");
    const decoded = await decryptArchiveFile(path, content, manifest, archiveKey);
    const chunkId = parseChunkIdFromPath(path);
    const codec =
      (chunkId ? chunkCodecById.get(chunkId) : undefined) ?? (manifest.chunkCodec as ChunkCodec);
    events.push(...(await decodeChunkEvents(decoded, codec)));
  }

  return {
    manifest,
    events,
    timeIndex,
    requestIndex,
    invertedIndex,
    privacyManifest,
    integrity
  };
}

/**
 * The full manifest: format 2 archives keep it encrypted next to a plaintext envelope; format 1
 * archives store it as `manifest.json` itself.
 */
async function readFullManifest(
  zip: JSZip,
  envelope: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<ExportManifest> {
  if (!zip.file(ENCRYPTED_MANIFEST_PATH)) {
    return envelope;
  }

  const inner = await readArchiveJson<ExportManifest>(
    zip,
    ENCRYPTED_MANIFEST_PATH,
    envelope,
    archiveKey
  );
  return { ...inner, ...(envelope.encryption ? { encryption: envelope.encryption } : {}) };
}

async function addJsonFile(
  zip: JSZip,
  path: string,
  value: unknown,
  fileHashes: Record<string, string>,
  encryption: ArchiveEncryptionState | null = null
): Promise<void> {
  const content = new TextEncoder().encode(JSON.stringify(value, null, 2));
  const bytes = encryption ? await encryptForArchive(path, content, encryption) : content;
  zip.file(path, bytes);
  fileHashes[path] = await sha256Hex(bytes);
}

async function readJson<TValue>(zip: JSZip, path: string): Promise<TValue> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  const content = await file.async("string");
  return JSON.parse(content) as TValue;
}

async function readArchiveJson<TValue>(
  zip: JSZip,
  path: string,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<TValue> {
  const content = await readArchiveFileText(zip, path, manifest, archiveKey);
  return JSON.parse(content) as TValue;
}

async function readOptionalArchiveJson<TValue>(
  zip: JSZip,
  path: string,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<TValue | null> {
  if (!zip.file(path)) {
    return null;
  }

  return readArchiveJson<TValue>(zip, path, manifest, archiveKey);
}

async function readArchiveFileText(
  zip: JSZip,
  path: string,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<string> {
  const bytes = await readFileBytes(zip, path);
  const decrypted = await decryptArchiveFile(path, bytes, manifest, archiveKey);
  return new TextDecoder().decode(decrypted);
}

async function verifyArchiveIntegrity(zip: JSZip, integrity: HashesManifest): Promise<void> {
  assertArchiveFileSet(zip, integrity);

  const manifestBytes = await readFileBytes(zip, "manifest.json");
  const manifestHash = await sha256Hex(manifestBytes);

  if (manifestHash !== integrity.manifestSha256) {
    throw new Error("Archive integrity mismatch for manifest.json");
  }

  for (const [path, expectedHash] of Object.entries(integrity.files)) {
    const actualHash = await sha256Hex(await readFileBytes(zip, path));

    if (actualHash !== expectedHash) {
      throw new Error(`Archive integrity mismatch for ${path}`);
    }
  }
}

function assertArchiveFileSet(zip: JSZip, integrity: HashesManifest): void {
  const actualPaths = Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path)
    .filter((path) => path !== "integrity/hashes.json")
    .sort();
  const expectedPaths = Object.keys(integrity.files).sort();

  if (actualPaths.length !== expectedPaths.length) {
    throw new Error("Archive integrity manifest does not match archive contents.");
  }

  for (let index = 0; index < actualPaths.length; index += 1) {
    if (actualPaths[index] !== expectedPaths[index]) {
      throw new Error("Archive integrity manifest does not match archive contents.");
    }
  }
}

async function readFileBytes(zip: JSZip, path: string): Promise<Uint8Array> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  return file.async("uint8array");
}

type ArchiveEncryptionState = {
  key: CryptoKey;
  meta: ExportEncryption;
};

async function createArchiveEncryptionState(passphrase: string): Promise<ArchiveEncryptionState> {
  const salt = randomBytes(16);
  const key = await deriveArchiveKey(passphrase, salt, ARCHIVE_KDF_DEFAULT_ITERATIONS, "encrypt");

  return {
    key,
    meta: {
      algorithm: "AES-GCM",
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: ARCHIVE_KDF_DEFAULT_ITERATIONS,
        saltBase64: toBase64(salt)
      },
      files: {}
    }
  };
}

async function encryptForArchive(
  path: string,
  bytes: Uint8Array,
  state: ArchiveEncryptionState
): Promise<Uint8Array> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const encrypted = await encryptBytes(bytes, state.key, iv);

  state.meta.files[path] = {
    ivBase64: toBase64(iv)
  };

  return encrypted;
}

/**
 * The archive key. Writers encrypt with the trimmed passphrase; older archives may have used it
 * untrimmed, so both are tried against one encrypted file before the key is used.
 */
async function resolveArchiveReadKey(
  zip: JSZip,
  manifest: ExportManifest,
  passphrase?: string
): Promise<CryptoKey | null> {
  const encryption = manifest.encryption;

  if (!encryption) {
    return null;
  }

  if (!passphrase) {
    throw new Error("Archive is encrypted. Provide a passphrase to read it.");
  }

  assertArchiveKdfIterations(encryption.kdf.iterations);

  const candidates = [...new Set([passphrase.trim(), passphrase])].filter(
    (candidate) => candidate.length > 0
  );
  const probe = Object.entries(encryption.files).find(([path]) => zip.file(path));
  let key: CryptoKey | null = null;

  for (const candidate of candidates) {
    key = await deriveArchiveKey(
      candidate,
      fromBase64(encryption.kdf.saltBase64),
      encryption.kdf.iterations,
      "decrypt"
    );

    if (!probe || candidates.length === 1) {
      return key;
    }

    try {
      const bytes = (await zip.file(probe[0])?.async("uint8array")) ?? new Uint8Array();
      await decryptBytes(bytes, key, fromBase64(probe[1].ivBase64));
      return key;
    } catch {
      // Wrong candidate: try the next one.
    }
  }

  return key;
}

async function decryptArchiveFile(
  path: string,
  bytes: Uint8Array,
  manifest: ExportManifest,
  archiveKey: CryptoKey | null
): Promise<Uint8Array> {
  const encryption = manifest.encryption;

  if (!encryption) {
    return bytes;
  }

  const fileMeta = encryption.files[path];

  if (!fileMeta) {
    return bytes;
  }

  if (!archiveKey) {
    throw new Error("Archive is encrypted. Missing decryption key.");
  }

  try {
    return await decryptBytes(bytes, archiveKey, fromBase64(fileMeta.ivBase64));
  } catch {
    throw new Error("Unable to decrypt archive content. The passphrase may be invalid.");
  }
}

async function deriveArchiveKey(
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
      salt: toArrayBuffer(salt)
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

async function encryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const encrypted = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(source)
  );

  return new Uint8Array(encrypted);
}

async function decryptBytes(
  bytes: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoApi = requireCryptoApi();
  const source = new Uint8Array(bytes.byteLength);
  source.set(bytes);
  const decrypted = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv)
    },
    key,
    toArrayBuffer(source)
  );

  return new Uint8Array(decrypted);
}

function randomBytes(size: number): Uint8Array {
  const cryptoApi = requireCryptoApi();
  const bytes = new Uint8Array(size);
  cryptoApi.getRandomValues(bytes);
  return bytes;
}

function requireCryptoApi(): Crypto {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined") {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is required for archive encryption.");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBase64(bytes: Uint8Array): string {
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

function fromBase64(value: string): Uint8Array {
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

function parseChunkIdFromPath(path: string): string | null {
  const match = /^events\/(.+)\.ndjson$/.exec(path);
  return match?.[1] ?? null;
}
