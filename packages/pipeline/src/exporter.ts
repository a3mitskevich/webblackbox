import JSZip from "jszip";

import { assertArchiveKdfIterations, ENCRYPTED_MANIFEST_PATH } from "@webblackbox/protocol";

import type {
  ChunkCodec,
  ChunkTimeIndexEntry,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { decryptBytes, deriveArchiveKey, fromBase64 } from "./archive-crypto.js";
import {
  ARCHIVE_INVERTED_INDEX_PATH,
  ARCHIVE_PRIVACY_MANIFEST_PATH,
  ARCHIVE_REQUEST_INDEX_PATH,
  ARCHIVE_TIME_INDEX_PATH,
  ArchiveWriter
} from "./archive-writer.js";
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

export async function createWebBlackboxArchive(
  input: ExportBundleInput,
  options: ArchiveExportOptions = {}
): Promise<ExportBundleOutput> {
  const parts: Uint8Array[] = [];
  const writer = await ArchiveWriter.create({
    passphrase: options.passphrase,
    sink: (part) => {
      parts.push(part);
    }
  });

  for (const chunk of input.chunks) {
    await writer.addChunk(chunk.meta.chunkId, chunk.bytes);
  }

  await writer.addJson(ARCHIVE_TIME_INDEX_PATH, input.timeIndex, "compact");
  await writer.addJson(ARCHIVE_REQUEST_INDEX_PATH, input.requestIndex, "compact");
  await writer.addJson(ARCHIVE_INVERTED_INDEX_PATH, input.invertedIndex, "compact");
  await writer.addJson(ARCHIVE_PRIVACY_MANIFEST_PATH, input.privacyManifest, "pretty");

  for (const blob of input.blobs) {
    await writer.addBlob(blob);
  }

  const { integrity } = await writer.finish(input.manifest);

  return {
    bytes: concatBytes(parts),
    integrity
  };
}

/** Joins sink parts into one array; callers that can keep parts apart should (see `createArchiveBlobSink`). */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
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

function parseChunkIdFromPath(path: string): string | null {
  const match = /^events\/(.+)\.ndjson$/.exec(path);
  return match?.[1] ?? null;
}
