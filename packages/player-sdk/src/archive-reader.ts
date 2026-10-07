import JSZip from "jszip";

import {
  assertArchiveKdfIterations,
  type ChunkCodec,
  type ChunkTimeIndexEntry,
  ENCRYPTED_MANIFEST_PATH,
  type ExportManifest,
  type HashesManifest,
  inferBlobMime,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

import { decryptBytes, deriveArchiveKey, fromBase64, sha256Hex } from "./archive-crypto.js";
import {
  type ArchiveLoadLimits,
  assertArchiveWithinLimits,
  readZipEntryBytes,
  resolveArchiveLoadLimits
} from "./archive-limits.js";
import {
  parseArchiveEnvelope,
  parseArchiveIntegrity,
  parseArchiveInvertedIndex,
  parseArchiveManifest,
  parseArchivePrivacyManifest,
  parseArchiveRequestIndex,
  parseArchiveTimeIndex
} from "./archive-schema.js";
import { decodeChunkBytes, resolveChunkDecodeLimit } from "./chunk-codec.js";
import { sortEventsForTimeline } from "./event-order.js";
import type { PlayerArchive, PlayerOpenInput, PlayerOpenOptions, PlayerRange } from "./types.js";

export type BlobRef = {
  path: string;
  mime: string;
};

export type ArchiveEncryptedFileMeta = {
  ivBase64: string;
};

type IntegrityArchiveReader = {
  zip: JSZip;
  integrity: HashesManifest;
  archiveKey: CryptoKey | null;
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>;
  limits: ArchiveLoadLimits;
};

export type EventChunkSource = {
  chunkId: string;
  path: string;
  seq: number;
  monoStart: number;
  monoEnd: number;
  bytes: Uint8Array;
};

export type ChunkMonoBounds = Pick<EventChunkSource, "monoStart" | "monoEnd">;

type EventChunkDescriptor = {
  chunkId: string;
  path: string;
  seq: number;
  monoStart: number;
  monoEnd: number;
  codec: ChunkCodec;
};

/** What `WebBlackboxPlayer.open` reads from an archive before building the player. */
export type OpenedArchive = {
  zip: JSZip;
  archive: PlayerArchive;
  eventChunks: EventChunkSource[];
  archiveKey: CryptoKey | null;
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>;
  limits: ArchiveLoadLimits;
};

/** Reads, verifies and decrypts the archive's manifest, indexes and event chunks. */
export async function openArchive(
  input: PlayerOpenInput,
  options: PlayerOpenOptions = {}
): Promise<OpenedArchive> {
  const limits = resolveArchiveLoadLimits(options.limits);
  const bytes = await normalizeOpenInput(input);
  const zip = await JSZip.loadAsync(bytes);
  assertArchiveWithinLimits(zip, limits);

  const integrity = parseArchiveIntegrity(
    await readZipFileBytes(zip, "integrity/hashes.json", limits)
  );
  assertArchiveFileSet(zip, integrity);
  const manifestBytes = await readZipFileBytes(zip, "manifest.json", limits);
  await assertManifestIntegrity(manifestBytes, integrity);
  // Format 2 keeps the full manifest encrypted; format 1 stores it as `manifest.json` itself.
  const hasEncryptedManifest = zip.file(ENCRYPTED_MANIFEST_PATH) !== null;
  const envelope = hasEncryptedManifest
    ? parseArchiveEnvelope(manifestBytes)
    : parseArchiveManifest(manifestBytes);
  const archiveKey = await resolveArchiveReadKey(zip, envelope, options.passphrase, limits);
  const encryptedFiles = envelope.encryption?.files ?? {};
  const reader: IntegrityArchiveReader = { zip, integrity, archiveKey, encryptedFiles, limits };
  const manifest: ExportManifest = hasEncryptedManifest
    ? {
        ...(await readIntegrityArchiveJson(reader, ENCRYPTED_MANIFEST_PATH, (bytes) =>
          parseArchiveManifest(bytes, ENCRYPTED_MANIFEST_PATH)
        )),
        ...(envelope.encryption ? { encryption: envelope.encryption } : {})
      }
    : parseArchiveManifest(manifestBytes);
  const timeIndex = await readIntegrityArchiveJson(
    reader,
    "index/time.json",
    parseArchiveTimeIndex
  );
  const requestIndex = await readIntegrityArchiveJson(
    reader,
    "index/req.json",
    parseArchiveRequestIndex
  );
  const invertedIndex = await readIntegrityArchiveJson(
    reader,
    "index/inv.json",
    parseArchiveInvertedIndex
  );
  const privacyManifest = await readOptionalIntegrityArchiveJson(
    reader,
    "privacy/manifest.json",
    parseArchivePrivacyManifest
  );
  const eventChunks = await readEventChunkSources(reader, {
    range: options.range,
    timeIndex,
    defaultCodec: manifest.chunkCodec
  });

  return {
    zip,
    archive: {
      manifest,
      timeIndex,
      requestIndex,
      invertedIndex,
      integrity,
      privacyManifest
    },
    eventChunks,
    archiveKey,
    encryptedFiles,
    limits
  };
}

/** Blob lookup by exact path, bare hash and `sha256-` hash. */
export function buildBlobIndex(zip: JSZip): Map<string, BlobRef> {
  const blobsByHash = new Map<string, BlobRef>();

  for (const path of Object.keys(zip.files)) {
    const parsed = parseBlobPath(path);

    if (!parsed) {
      continue;
    }

    const blobRef: BlobRef = {
      path,
      mime: inferBlobMime(parsed.extension)
    };

    // Always register exact path lookups to avoid collisions across extensions.
    blobsByHash.set(path, blobRef);

    setBlobAliasIfAbsent(blobsByHash, parsed.hash, blobRef);
    setBlobAliasIfAbsent(blobsByHash, `sha256-${parsed.hash}`, blobRef);
  }

  return blobsByHash;
}

/**
 * The archive key. Writers encrypt with the trimmed passphrase; older archives may have used it
 * untrimmed, so both are tried against one encrypted file before the key is used.
 */
async function resolveArchiveReadKey(
  zip: JSZip,
  manifest: Pick<ExportManifest, "encryption">,
  passphrase: string | undefined,
  limits: ArchiveLoadLimits
): Promise<CryptoKey | null> {
  const encryption = manifest.encryption;

  if (!encryption) {
    return null;
  }

  if (!passphrase) {
    throw new Error("Archive is encrypted. Provide a passphrase to open it.");
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
      encryption.kdf.iterations
    );

    if (!probe || candidates.length === 1) {
      return key;
    }

    try {
      // Bounded read, like every other entry: the probe is still an untrusted file.
      const bytes = await readZipFileBytes(zip, probe[0], limits);
      await decryptBytes(bytes, key, fromBase64(probe[1].ivBase64));
      return key;
    } catch {
      // Wrong candidate: try the next one.
    }
  }

  return key;
}

async function readEventChunkSources(
  reader: IntegrityArchiveReader,
  options: {
    range?: PlayerRange;
    timeIndex?: ChunkTimeIndexEntry[];
    defaultCodec?: ChunkCodec;
  } = {}
): Promise<EventChunkSource[]> {
  const { zip, integrity, archiveKey, encryptedFiles, limits } = reader;
  const descriptors = buildEventChunkDescriptors(zip, options);
  const chunks: EventChunkSource[] = [];
  let decodedTotalBytes = 0;

  for (const descriptor of descriptors) {
    const { path } = descriptor;
    const file = zip.file(path);

    if (!file) {
      continue;
    }

    const rawBytes = await readZipEntryBytes(file, limits);
    await assertArchiveFileIntegrity(integrity, path, rawBytes);

    const decrypted = await decryptArchiveBytes(path, rawBytes, archiveKey, encryptedFiles);
    const bytes = await decodeChunkBytes(
      decrypted,
      descriptor.codec,
      resolveChunkDecodeLimit(path, descriptor.codec, limits, decodedTotalBytes)
    );
    decodedTotalBytes += bytes.byteLength;

    chunks.push({
      chunkId: descriptor.chunkId,
      path,
      seq: descriptor.seq,
      monoStart: descriptor.monoStart,
      monoEnd: descriptor.monoEnd,
      bytes
    });
  }

  return chunks.sort((left, right) => left.seq - right.seq);
}

function buildEventChunkDescriptors(
  zip: JSZip,
  options: {
    range?: PlayerRange;
    timeIndex?: ChunkTimeIndexEntry[];
    defaultCodec?: ChunkCodec;
  }
): EventChunkDescriptor[] {
  const { range, timeIndex } = options;
  const defaultCodec = options.defaultCodec ?? "none";

  if (Array.isArray(timeIndex) && timeIndex.length > 0) {
    return timeIndex
      .map((entry) => ({ ...entry, ...normalizeIndexedChunkBounds(entry) }))
      .filter((entry) => !range || chunkIntersectsRange(entry, range))
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => ({
        chunkId: entry.chunkId,
        path: `events/${entry.chunkId}.ndjson`,
        seq: entry.seq,
        monoStart: entry.monoStart,
        monoEnd: entry.monoEnd,
        codec: entry.codec
      }));
  }

  return Object.keys(zip.files)
    .filter((path) => path.startsWith("events/") && path.endsWith(".ndjson"))
    .sort()
    .map((path, index) => ({
      chunkId: parseChunkIdFromPath(path) ?? `chunk-${String(index + 1).padStart(6, "0")}`,
      path,
      seq: index + 1,
      monoStart: Number.NEGATIVE_INFINITY,
      monoEnd: Number.POSITIVE_INFINITY,
      codec: defaultCodec
    }));
}

/** Parses a chunk's NDJSON into timeline order (chunks store events in arrival order). */
export function parseChunkEvents(chunk: EventChunkSource): WebBlackboxEvent[] {
  const content = new TextDecoder().decode(chunk.bytes);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: WebBlackboxEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as WebBlackboxEvent);
    } catch (error) {
      throw new Error(
        `Failed to parse chunk '${chunk.chunkId}' from '${chunk.path}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return sortEventsForTimeline(events);
}

/**
 * Pipelines before the ordering fix recorded the first and last event of a chunk rather than its
 * min/max, so legacy bounds can be inverted when the last event arrived late.
 */
function normalizeIndexedChunkBounds(entry: ChunkTimeIndexEntry): ChunkMonoBounds {
  return {
    monoStart: Math.min(entry.monoStart, entry.monoEnd),
    monoEnd: Math.max(entry.monoStart, entry.monoEnd)
  };
}

function chunkIntersectsRange(entry: ChunkMonoBounds, range: PlayerRange): boolean {
  if (range.monoStart !== undefined && entry.monoEnd < range.monoStart) {
    return false;
  }

  if (range.monoEnd !== undefined && entry.monoStart > range.monoEnd) {
    return false;
  }

  return true;
}

async function decryptArchiveBytes(
  path: string,
  bytes: Uint8Array,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<Uint8Array> {
  const encryptedFile = encryptedFiles[path];

  if (!encryptedFile) {
    return bytes;
  }

  if (!archiveKey) {
    throw new Error("Archive is encrypted. Missing decryption key.");
  }

  return decryptBytes(bytes, archiveKey, fromBase64(encryptedFile.ivBase64));
}

/** Blob reads: as `decryptArchiveBytes`, with an unreadable IV reported as a passphrase problem. */
export async function decryptArchiveFile(
  path: string,
  bytes: Uint8Array,
  archiveKey: CryptoKey | null,
  encryptedFiles: Record<string, ArchiveEncryptedFileMeta>
): Promise<Uint8Array> {
  const encryptedFile = encryptedFiles[path];

  if (!encryptedFile) {
    return bytes;
  }

  if (!archiveKey) {
    throw new Error("Archive is encrypted. Missing decryption key.");
  }

  try {
    return decryptBytes(bytes, archiveKey, fromBase64(encryptedFile.ivBase64));
  } catch {
    throw new Error("Unable to decrypt archive content. The passphrase may be invalid.");
  }
}

function parseChunkIdFromPath(path: string): string | null {
  const match = /^events\/(.+)\.ndjson$/.exec(path);
  return match?.[1] ?? null;
}

async function readIntegrityArchiveJson<TValue>(
  reader: IntegrityArchiveReader,
  path: string,
  parse: (bytes: Uint8Array) => TValue
): Promise<TValue> {
  const rawBytes = await readZipFileBytes(reader.zip, path, reader.limits);
  await assertArchiveFileIntegrity(reader.integrity, path, rawBytes);
  const bytes = await decryptArchiveBytes(path, rawBytes, reader.archiveKey, reader.encryptedFiles);
  return parse(bytes);
}

async function readOptionalIntegrityArchiveJson<TValue>(
  reader: IntegrityArchiveReader,
  path: string,
  parse: (bytes: Uint8Array) => TValue
): Promise<TValue | null> {
  if (!reader.zip.file(path)) {
    return null;
  }

  return readIntegrityArchiveJson(reader, path, parse);
}

async function readZipFileBytes(
  zip: JSZip,
  path: string,
  limits: ArchiveLoadLimits
): Promise<Uint8Array> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  return readZipEntryBytes(file, limits);
}

async function assertManifestIntegrity(
  manifestBytes: Uint8Array,
  integrity: HashesManifest
): Promise<void> {
  const actual = await sha256Hex(manifestBytes);

  if (actual !== integrity.manifestSha256) {
    throw new Error("Archive integrity mismatch for manifest.json");
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

export async function assertArchiveFileIntegrity(
  integrity: HashesManifest,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const expected = integrity.files[path];

  if (!expected) {
    throw new Error(`Archive integrity manifest is missing hash for ${path}`);
  }

  const actual = await sha256Hex(bytes);

  if (actual !== expected) {
    throw new Error(`Archive integrity mismatch for ${path}`);
  }
}

function parseBlobPath(path: string): { hash: string; extension: string } | null {
  const prefixed = /^blobs\/sha256-([^.]+)\.(.+)$/.exec(path);

  if (!prefixed) {
    return null;
  }

  const hash = prefixed[1];
  const extension = prefixed[2];

  if (!hash || !extension) {
    return null;
  }

  return { hash, extension };
}

function setBlobAliasIfAbsent(
  blobsByHash: Map<string, BlobRef>,
  alias: string,
  blob: BlobRef
): void {
  if (!blobsByHash.has(alias)) {
    blobsByHash.set(alias, blob);
  }
}

export function resolveBlobByKey(blobsByHash: Map<string, BlobRef>, input: string): BlobRef | null {
  const candidate = normalizeBlobHashCandidate(input);

  if (!candidate) {
    return null;
  }

  return blobsByHash.get(candidate) ?? null;
}

function normalizeBlobHashCandidate(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("blobs/")) {
    return trimmed;
  }

  return trimmed.startsWith("sha256-") ? trimmed.slice("sha256-".length) : trimmed;
}

async function normalizeOpenInput(input: PlayerOpenInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }

  throw new Error("Unsupported archive input type.");
}
