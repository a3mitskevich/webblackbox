import {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_KDF_DEFAULT_ITERATIONS,
  assertExportPassphrase,
  ENCRYPTED_MANIFEST_PATH,
  inferBlobFileExtension,
  normalizeExportPassphrase
} from "@webblackbox/protocol";
import type {
  ArchiveEnvelopeManifest,
  ExportEncryption,
  ExportManifest,
  HashesManifest
} from "@webblackbox/protocol";

import {
  AES_GCM_IV_BYTES,
  AES_GCM_TAG_BYTES,
  deriveArchiveKey,
  encryptBytes,
  randomBytes,
  toBase64
} from "./archive-crypto.js";
import { sha256Hex } from "./hash.js";
import type { ArchiveSink } from "./zip-writer.js";
import { STORE_ZIP_END_BYTES, StoreZipWriter, storeZipEntryBytes } from "./zip-writer.js";

export type { ArchiveSink } from "./zip-writer.js";

export const ENVELOPE_MANIFEST_PATH = "manifest.json";
export const INTEGRITY_MANIFEST_PATH = "integrity/hashes.json";
export const ARCHIVE_TIME_INDEX_PATH = "index/time.json";
export const ARCHIVE_REQUEST_INDEX_PATH = "index/req.json";
export const ARCHIVE_INVERTED_INDEX_PATH = "index/inv.json";
export const ARCHIVE_PRIVACY_MANIFEST_PATH = "privacy/manifest.json";

/** An encrypted archive file, by path and plaintext size: what the archive size depends on. */
export type ArchiveFileSize = {
  path: string;
  plainBytes: number;
};

export type ArchiveWriterOptions = {
  /** Required: every archive is encrypted (at least 8 characters, trimmed). */
  passphrase?: string;
  sink: ArchiveSink;
  createdAt?: Date;
};

export type ArchiveWriteResult = {
  integrity: HashesManifest;
  sizeBytes: number;
};

// Placeholders with the exact length of a 12-byte IV and a 16-byte salt in base64 and of a
// SHA-256 hex digest: the trailing manifests' sizes do not depend on their values.
const IV_BASE64_PLACEHOLDER = "A".repeat(16);
const SALT_BASE64_PLACEHOLDER = "A".repeat(24);
const SHA256_HEX_PLACEHOLDER = "0".repeat(64);
const KDF_SALT_BYTES = 16;

export function chunkArchivePath(chunkId: string): string {
  return `events/${chunkId}.ndjson`;
}

export function blobArchivePath(hash: string, mime: string): string {
  return `blobs/sha256-${hash}.${inferBlobFileExtension(mime)}`;
}

/** Index files scale with the session, so they are written without indentation. */
export function encodeArchiveJson(value: unknown, format: "compact" | "pretty"): Uint8Array {
  return new TextEncoder().encode(
    format === "compact" ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  );
}

/**
 * Exact size of an archive holding `files` (in write order, each encrypted) plus the trailing
 * encrypted manifest, plaintext envelope and integrity manifest that `ArchiveWriter.finish` adds.
 */
export function computeArchiveBytes(
  files: Iterable<ArchiveFileSize>,
  manifestPlainBytes: number
): number {
  const encryptedPaths: string[] = [];
  let total = STORE_ZIP_END_BYTES;

  for (const file of files) {
    encryptedPaths.push(file.path);
    total += storeZipEntryBytes(file.path, file.plainBytes + AES_GCM_TAG_BYTES);
  }

  encryptedPaths.push(ENCRYPTED_MANIFEST_PATH);
  total += storeZipEntryBytes(ENCRYPTED_MANIFEST_PATH, manifestPlainBytes + AES_GCM_TAG_BYTES);

  const meta = buildEncryptionMeta(ARCHIVE_KDF_DEFAULT_ITERATIONS, SALT_BASE64_PLACEHOLDER);

  for (const path of encryptedPaths) {
    meta.files[path] = { ivBase64: IV_BASE64_PLACEHOLDER };
  }

  const envelope = encodeArchiveJson(buildEnvelope(meta), "pretty");
  const hashes = Object.fromEntries(
    [...encryptedPaths, ENVELOPE_MANIFEST_PATH].map((path) => [path, SHA256_HEX_PLACEHOLDER])
  );
  const integrity = encodeArchiveJson(
    { manifestSha256: SHA256_HEX_PLACEHOLDER, files: hashes },
    "pretty"
  );

  return (
    total +
    storeZipEntryBytes(ENVELOPE_MANIFEST_PATH, envelope.byteLength) +
    storeZipEntryBytes(INTEGRITY_MANIFEST_PATH, integrity.byteLength)
  );
}

/**
 * Writes a `.webblackbox` archive file by file: each file is encrypted with its own IV, hashed
 * and handed to the sink straight away, so only one file is in memory at a time. `finish` adds
 * the encrypted full manifest, the plaintext envelope listing every IV, and the integrity hashes.
 */
export class ArchiveWriter {
  private readonly fileHashes: Record<string, string> = {};

  private constructor(
    private readonly zip: StoreZipWriter,
    private readonly key: CryptoKey,
    private readonly encryption: ExportEncryption
  ) {}

  public static async create(options: ArchiveWriterOptions): Promise<ArchiveWriter> {
    // There is no plaintext export: the passphrase is checked here, below every caller.
    assertExportPassphrase(options.passphrase);

    const passphrase = normalizeExportPassphrase(options.passphrase);
    const salt = randomBytes(KDF_SALT_BYTES);
    const key = await deriveArchiveKey(passphrase, salt, ARCHIVE_KDF_DEFAULT_ITERATIONS, "encrypt");

    return new ArchiveWriter(
      new StoreZipWriter(options.sink, options.createdAt),
      key,
      buildEncryptionMeta(ARCHIVE_KDF_DEFAULT_ITERATIONS, toBase64(salt))
    );
  }

  public get bytesWritten(): number {
    return this.zip.bytesWritten;
  }

  public async addEncryptedFile(path: string, plaintext: Uint8Array): Promise<void> {
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const ciphertext = await encryptBytes(plaintext, this.key, iv);

    this.encryption.files[path] = { ivBase64: toBase64(iv) };
    await this.addFile(path, ciphertext);
  }

  public addChunk(chunkId: string, bytes: Uint8Array): Promise<void> {
    return this.addEncryptedFile(chunkArchivePath(chunkId), bytes);
  }

  public addBlob(blob: { hash: string; mime: string; bytes: Uint8Array }): Promise<void> {
    return this.addEncryptedFile(blobArchivePath(blob.hash, blob.mime), blob.bytes);
  }

  public addJson(path: string, value: unknown, format: "compact" | "pretty"): Promise<void> {
    return this.addEncryptedFile(path, encodeArchiveJson(value, format));
  }

  public async finish(manifest: ExportManifest): Promise<ArchiveWriteResult> {
    // Everything derived from the recording (site, mode, stats, redaction rules) is encrypted;
    // the plaintext envelope carries only what decryption needs. Written last: it lists every IV.
    await this.addJson(ENCRYPTED_MANIFEST_PATH, manifest, "pretty");
    await this.addFile(
      ENVELOPE_MANIFEST_PATH,
      encodeArchiveJson(buildEnvelope(this.encryption), "pretty")
    );

    const integrity: HashesManifest = {
      manifestSha256: this.fileHashes[ENVELOPE_MANIFEST_PATH] ?? "",
      files: { ...this.fileHashes }
    };

    await this.zip.addFile(INTEGRITY_MANIFEST_PATH, encodeArchiveJson(integrity, "pretty"));

    return { integrity, sizeBytes: await this.zip.finish() };
  }

  private async addFile(path: string, bytes: Uint8Array): Promise<void> {
    this.fileHashes[path] = await sha256Hex(bytes);
    await this.zip.addFile(path, bytes);
  }
}

function buildEncryptionMeta(iterations: number, saltBase64: string): ExportEncryption {
  return {
    algorithm: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      saltBase64
    },
    files: {}
  };
}

function buildEnvelope(encryption: ExportEncryption): ArchiveEnvelopeManifest {
  return {
    protocolVersion: ARCHIVE_FORMAT_VERSION,
    encryption
  };
}
