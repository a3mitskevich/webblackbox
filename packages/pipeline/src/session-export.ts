import type {
  CapturePolicy,
  ChunkCodec,
  ChunkTimeIndexEntry,
  ExportManifest,
  HashesManifest,
  PrivacyManifest,
  PrivacyScannerFinding,
  RedactionProfile,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";
import {
  ARCHIVE_FORMAT_VERSION,
  DEFAULT_EXPORT_POLICY,
  sanitizeUrlForPrivacy
} from "@webblackbox/protocol";

import { AES_GCM_TAG_BYTES } from "./archive-crypto.js";
import {
  ARCHIVE_INVERTED_INDEX_PATH,
  ARCHIVE_PRIVACY_MANIFEST_PATH,
  ARCHIVE_REQUEST_INDEX_PATH,
  ARCHIVE_TIME_INDEX_PATH,
  type ArchiveFileSize,
  type ArchiveSink,
  ArchiveWriter,
  blobArchivePath,
  chunkArchivePath,
  computeArchiveBytes,
  encodeArchiveJson
} from "./archive-writer.js";
import { collectBlobHashesFromEvents } from "./blob-hashes.js";
import { computeChunkTimeBounds } from "./chunker.js";
import { decodeChunkEvents, encodeChunkEvents } from "./codec.js";
import { sha256Hex } from "./hash.js";
import { EventIndexer } from "./indexer.js";
import {
  assemblePrivacyManifest,
  isPrivacyScannedMime,
  type PrivacyEventScan,
  scanPrivacyBlob,
  scanPrivacyEvents
} from "./privacy.js";
import type { PipelineStorage, StoredBlobInfo, StoredChunk, StoredIndexes } from "./storage.js";
import { storeZipEntryBytes } from "./zip-writer.js";

export type ExportBundleOptions = {
  /** Required: every archive is encrypted (at least 8 characters, trimmed). */
  passphrase?: string;
  includeScreenshots?: boolean;
  includeScreenRecordings?: boolean;
  maxArchiveBytes?: number | null;
  recentWindowMs?: number | null;
};

export type ArchiveExportResult = {
  fileName: string;
  sizeBytes: number;
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest;
};

export type SessionExportContext = {
  storage: PipelineStorage;
  session: SessionMetadata;
  /** Codec named in the manifest of an archive without chunks. */
  chunkCodec: ChunkCodec;
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
};

type ResolvedExportPolicy = {
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number | null;
  recentWindowMs: number | null;
  cutoffTimestamp: number;
  /** False when the policy keeps every event: chunks are exported exactly as stored. */
  filtersEvents: boolean;
};

/** One stored chunk in an export: its stored meta, and the meta of what is exported. */
type ChunkPlan = {
  meta: ChunkTimeIndexEntry;
  exportMeta: ChunkTimeIndexEntry;
  /** True when the policy dropped some of the chunk's events (the chunk is re-encoded). */
  filtered: boolean;
  blobHashes: string[];
};

type ExportPlan = {
  chunks: ChunkPlan[];
  blobs: StoredBlobInfo[];
  indexes: StoredIndexes;
  requestIndexBytes: Uint8Array;
  invertedIndexBytes: Uint8Array;
  privacyManifest: PrivacyManifest;
  privacyManifestBytes: Uint8Array;
  manifest: ExportManifest;
  archiveBytes: number;
};

const SCREENSHOT_EVENT_TYPE: WebBlackboxEvent["type"] = "screen.screenshot";
const SCREEN_RECORDING_EVENT_PREFIX = "screen.recording.";
// Headroom for the manifests and privacy manifest; indexes are estimated per chunk.
const EXPORT_OVERHEAD_RESERVE_BYTES = 512 * 1024;
const EXPORT_OVERHEAD_RESERVE_RATIO = 0.1;
// When a plan is over the limit, drop a little more than the estimate says: the inverted index
// shrinks less than proportionally (terms are shared), and each extra plan re-reads the chunks.
const DROP_MARGIN_RATIO = 0.05;
const DROP_MARGIN_BYTES = 64 * 1024;

/**
 * Exports a stored session as a `.webblackbox` archive into `sink`, holding at most one chunk
 * or one blob at a time (plus the indexes of what is exported):
 *
 * 1. select — chunk metas newest first; each chunk is decoded and filtered on its own and
 *    counted against the size budget with blob sizes from storage metadata;
 * 2. plan — indexes and privacy manifest of the selection give the exact archive size; when it
 *    is over the limit, the oldest chunks are dropped by their estimated share and it is planned
 *    again (instead of building whole archives for a binary search);
 * 3. write — chunks, indexes, privacy manifest and blobs are encrypted and streamed one by one.
 */
export async function exportSessionArchive(
  context: SessionExportContext,
  options: ExportBundleOptions,
  sink: ArchiveSink
): Promise<ArchiveExportResult> {
  const { storage, session } = context;
  const metas = await listChunkMetas(storage, session.sid);
  const policy = resolveExportPolicy(options, {
    latestEventTimestamp: metas[metas.length - 1]?.tEnd,
    sessionStartedAt: session.startedAt,
    sessionEndedAt: session.endedAt
  });
  const source = new SessionExportSource(context, policy);
  let plan = await source.plan(await source.selectChunks(metas));

  while (
    policy.maxArchiveBytes !== null &&
    plan.archiveBytes > policy.maxArchiveBytes &&
    plan.chunks.length > 0
  ) {
    plan = await source.plan(dropOldestChunks(plan, plan.archiveBytes - policy.maxArchiveBytes));
  }

  // A whole-session export also refreshes the stored indexes.
  if (!policy.filtersEvents && policy.maxArchiveBytes === null) {
    await storage.putIndexes(session.sid, plan.indexes);
  }

  const { integrity, sizeBytes } = await source.write(plan, options.passphrase, sink);

  await storage.putIntegrity(session.sid, integrity);

  return {
    fileName: `${session.sid}.webblackbox`,
    sizeBytes,
    integrity,
    privacyManifest: plan.privacyManifest
  };
}

/** Time, request and inverted indexes of every stored chunk, read one chunk at a time. */
export async function buildSessionIndexes(
  storage: PipelineStorage,
  sid: string
): Promise<StoredIndexes> {
  const indexer = new EventIndexer();

  for (const meta of await listChunkMetas(storage, sid)) {
    const chunk = await storage.getChunk(sid, meta.chunkId);

    indexer.addChunk(meta);

    if (chunk) {
      indexer.addEvents(await decodeChunkEvents(chunk.bytes, chunk.meta.codec));
    }
  }

  return indexer.snapshot();
}

/** Reads one session's chunks and blobs for an export, caching what replanning reuses. */
class SessionExportSource {
  private readonly eventScans = new Map<string, PrivacyEventScan>();
  private readonly blobFindings = new Map<string, PrivacyScannerFinding[]>();
  private readonly blobInfo = new Map<string, StoredBlobInfo | null>();
  private blobInfoLoaded = false;

  public constructor(
    private readonly context: SessionExportContext,
    private readonly policy: ResolvedExportPolicy
  ) {}

  private get sid(): string {
    return this.context.session.sid;
  }

  /** Newest chunks first, while chunk and new blob bytes fit the budget (oldest dropped first). */
  public async selectChunks(metas: ChunkTimeIndexEntry[]): Promise<ChunkPlan[]> {
    const budget = selectionBudget(this.policy.maxArchiveBytes);
    const selected: ChunkPlan[] = [];
    const selectedBlobs = new Set<string>();
    let indexBytesPerEvent: number | null = null;
    let totalBytes = 0;

    for (let index = metas.length - 1; index >= 0; index -= 1) {
      const meta = metas[index];

      // A chunk whose every event is older than the recent window is skipped unread.
      if (!meta || Math.max(meta.tStart, meta.tEnd) < this.policy.cutoffTimestamp) {
        continue;
      }

      const prepared = await this.prepareChunk(meta);

      if (!prepared) {
        continue;
      }

      const { plan } = prepared;

      if (budget !== null) {
        // Index size per event, sampled from the newest chunk: indexes take a large share of
        // an archive whose chunks are compressed.
        indexBytesPerEvent ??= estimateIndexBytesPerEvent(prepared.events);

        const candidateBytes =
          (await this.selectionBytes(plan, selectedBlobs)) +
          Math.ceil(indexBytesPerEvent * plan.exportMeta.eventCount);

        if (totalBytes + candidateBytes > budget && selected.length > 0) {
          break;
        }

        totalBytes += candidateBytes;
      }

      selected.push(plan);

      for (const hash of plan.blobHashes) {
        selectedBlobs.add(hash);
      }
    }

    return selected.reverse();
  }

  /** Indexes, privacy manifest and manifest of a selection, and the exact archive size. */
  public async plan(chunks: ChunkPlan[]): Promise<ExportPlan> {
    const indexer = new EventIndexer();
    const eventScans: PrivacyEventScan[] = [];
    const blobHashes = new Set<string>();

    for (const chunk of chunks) {
      const events = await this.readExportEvents(chunk);

      indexer.addChunk(chunk.exportMeta);
      indexer.addEvents(events);
      eventScans.push(await this.scanEvents(chunk, events));

      for (const hash of chunk.blobHashes) {
        blobHashes.add(hash);
      }
    }

    const blobs: StoredBlobInfo[] = [];
    const blobFindings: PrivacyScannerFinding[][] = [];

    for (const hash of [...blobHashes].sort()) {
      const info = await this.getBlobInfo(hash);

      if (info) {
        blobs.push(info);
        blobFindings.push(await this.scanBlob(info));
      }
    }

    const indexes = indexer.snapshot();
    const requestIndexBytes = encodeArchiveJson(indexes.request, "compact");
    const invertedIndexBytes = encodeArchiveJson(indexes.inverted, "compact");
    const privacyManifest = assemblePrivacyManifest({
      eventScans,
      blobFindings,
      blobCount: blobs.length,
      capturePolicy: this.context.capturePolicy,
      encrypted: true,
      transfer: buildExportTransferPolicy(this.context.capturePolicy, this.policy)
    });
    const privacyManifestBytes = encodeArchiveJson(privacyManifest, "pretty");
    const manifest = buildManifest(
      this.context,
      chunks.map((chunk) => chunk.exportMeta),
      blobs.length
    );
    const files: ArchiveFileSize[] = [
      ...chunks.map((chunk) => ({
        path: chunkArchivePath(chunk.exportMeta.chunkId),
        plainBytes: chunk.exportMeta.byteLength
      })),
      {
        path: ARCHIVE_TIME_INDEX_PATH,
        plainBytes: encodeArchiveJson(indexes.time, "compact").byteLength
      },
      { path: ARCHIVE_REQUEST_INDEX_PATH, plainBytes: requestIndexBytes.byteLength },
      { path: ARCHIVE_INVERTED_INDEX_PATH, plainBytes: invertedIndexBytes.byteLength },
      { path: ARCHIVE_PRIVACY_MANIFEST_PATH, plainBytes: privacyManifestBytes.byteLength },
      ...blobs.map((blob) => ({
        path: blobArchivePath(blob.hash, blob.mime),
        plainBytes: blob.size
      }))
    ];

    return {
      chunks,
      blobs,
      indexes,
      requestIndexBytes,
      invertedIndexBytes,
      privacyManifest,
      privacyManifestBytes,
      manifest,
      archiveBytes: computeArchiveBytes(files, encodeArchiveJson(manifest, "pretty").byteLength)
    };
  }

  /** Streams the planned archive: one chunk or blob in memory at a time. */
  public async write(
    plan: ExportPlan,
    passphrase: string | undefined,
    sink: ArchiveSink
  ): Promise<{ integrity: HashesManifest; sizeBytes: number }> {
    const writer = await ArchiveWriter.create({ passphrase, sink });
    const timeIndex: ChunkTimeIndexEntry[] = [];

    for (const chunk of plan.chunks) {
      const { bytes, codec } = await this.readExportBytes(chunk);
      // A re-encoded chunk is described by the bytes actually written: a codec can fall back to
      // "none" on this pass (a compression timeout) even though it compressed while planning.
      const meta = chunk.filtered
        ? {
            ...chunk.exportMeta,
            codec,
            byteLength: bytes.byteLength,
            sha256: await sha256Hex(bytes)
          }
        : chunk.exportMeta;

      timeIndex.push(meta);
      await writer.addChunk(meta.chunkId, bytes);
    }

    await writer.addJson(ARCHIVE_TIME_INDEX_PATH, timeIndex, "compact");
    await writer.addEncryptedFile(ARCHIVE_REQUEST_INDEX_PATH, plan.requestIndexBytes);
    await writer.addEncryptedFile(ARCHIVE_INVERTED_INDEX_PATH, plan.invertedIndexBytes);
    await writer.addEncryptedFile(ARCHIVE_PRIVACY_MANIFEST_PATH, plan.privacyManifestBytes);

    for (const info of plan.blobs) {
      const blob = await this.context.storage.getBlob(info.hash);

      if (!blob) {
        throw new Error(`Blob ${info.hash} disappeared while the session was being exported.`);
      }

      await writer.addBlob({ hash: info.hash, mime: info.mime, bytes: blob.bytes });
    }

    return writer.finish(plan.manifest);
  }

  /** Archive bytes a candidate chunk adds: the chunk and blobs not selected yet. */
  private async selectionBytes(plan: ChunkPlan, selectedBlobs: Set<string>): Promise<number> {
    let bytes = encryptedEntryBytes(
      chunkArchivePath(plan.meta.chunkId),
      plan.exportMeta.byteLength
    );

    for (const hash of plan.blobHashes) {
      const info = selectedBlobs.has(hash) ? null : await this.getBlobInfo(hash);

      if (info) {
        bytes += encryptedEntryBytes(blobArchivePath(hash, info.mime), info.size);
      }
    }

    return bytes;
  }

  /** The chunk's events kept by the policy, or null when it keeps none. */
  private async prepareChunk(
    meta: ChunkTimeIndexEntry
  ): Promise<{ plan: ChunkPlan; events: WebBlackboxEvent[] } | null> {
    const chunk = await this.context.storage.getChunk(this.sid, meta.chunkId);

    if (!chunk) {
      return null;
    }

    const events = await decodeChunkEvents(chunk.bytes, chunk.meta.codec);
    const kept = this.filterEvents(events);

    if (kept.length === 0) {
      return null;
    }

    const blobHashes = collectBlobHashesFromEvents(kept);

    if (kept.length === events.length) {
      return {
        plan: { meta: chunk.meta, exportMeta: chunk.meta, filtered: false, blobHashes },
        events: kept
      };
    }

    const encoded = await encodeChunkEvents(kept, chunk.meta.codec);

    return {
      plan: {
        meta: chunk.meta,
        exportMeta: {
          ...chunk.meta,
          ...computeChunkTimeBounds(kept, chunk.meta),
          eventCount: kept.length,
          byteLength: encoded.bytes.byteLength,
          codec: encoded.codec,
          sha256: await sha256Hex(encoded.bytes)
        },
        filtered: true,
        blobHashes
      },
      events: kept
    };
  }

  private filterEvents(events: WebBlackboxEvent[]): WebBlackboxEvent[] {
    return this.policy.filtersEvents
      ? events.filter((event) => shouldIncludeEvent(event, this.policy))
      : events;
  }

  private async readExportEvents(plan: ChunkPlan): Promise<WebBlackboxEvent[]> {
    const chunk = await this.requireChunk(plan.meta.chunkId);
    return this.filterEvents(await decodeChunkEvents(chunk.bytes, chunk.meta.codec));
  }

  private async readExportBytes(
    plan: ChunkPlan
  ): Promise<{ bytes: Uint8Array; codec: ChunkCodec }> {
    const chunk = await this.requireChunk(plan.meta.chunkId);

    if (!plan.filtered) {
      return { bytes: chunk.bytes, codec: chunk.meta.codec };
    }

    const events = this.filterEvents(await decodeChunkEvents(chunk.bytes, chunk.meta.codec));
    return encodeChunkEvents(events, plan.exportMeta.codec);
  }

  private async requireChunk(chunkId: string): Promise<StoredChunk> {
    const chunk = await this.context.storage.getChunk(this.sid, chunkId);

    if (!chunk) {
      throw new Error(`Chunk ${chunkId} disappeared while the session was being exported.`);
    }

    return chunk;
  }

  private async scanEvents(plan: ChunkPlan, events: WebBlackboxEvent[]): Promise<PrivacyEventScan> {
    const cached = this.eventScans.get(plan.meta.chunkId);

    if (cached) {
      return cached;
    }

    const scan = await scanPrivacyEvents(events);
    this.eventScans.set(plan.meta.chunkId, scan);
    return scan;
  }

  /** Text blobs are read once for the scanner; binary blobs are not read before writing. */
  private async scanBlob(info: StoredBlobInfo): Promise<PrivacyScannerFinding[]> {
    const cached = this.blobFindings.get(info.hash);

    if (cached) {
      return cached;
    }

    const blob = isPrivacyScannedMime(info.mime)
      ? await this.context.storage.getBlob(info.hash)
      : undefined;
    const findings = blob ? await scanPrivacyBlob(blob) : [];

    this.blobFindings.set(info.hash, findings);
    return findings;
  }

  /** Size and type of a referenced blob; null when it is not stored (a hash-like string). */
  private async getBlobInfo(hash: string): Promise<StoredBlobInfo | null> {
    if (!this.blobInfoLoaded) {
      this.blobInfoLoaded = true;

      for (const info of (await this.context.storage.listSessionBlobInfo?.(this.sid)) ?? []) {
        this.blobInfo.set(info.hash, info);
      }
    }

    const known = this.blobInfo.get(hash);

    if (known !== undefined) {
      return known;
    }

    const blob = await this.context.storage.getBlob(hash);
    const info = blob ? { hash, mime: blob.mime, size: blob.bytes.byteLength } : null;

    this.blobInfo.set(hash, info);
    return info;
  }
}

/** Chunk and blob bytes the selection may use: the limit minus a reserve for indexes. */
function selectionBudget(maxArchiveBytes: number | null): number | null {
  if (maxArchiveBytes === null) {
    return null;
  }

  const reserve = Math.min(
    EXPORT_OVERHEAD_RESERVE_BYTES,
    Math.floor(maxArchiveBytes * EXPORT_OVERHEAD_RESERVE_RATIO)
  );
  return Math.max(0, maxArchiveBytes - reserve);
}

/** Request and inverted index bytes per event, measured on a sample of events. */
function estimateIndexBytesPerEvent(events: WebBlackboxEvent[]): number {
  if (events.length === 0) {
    return 0;
  }

  const indexer = new EventIndexer();
  indexer.addEvents(events);
  const { request, inverted } = indexer.snapshot();

  return (
    (encodeArchiveJson(request, "compact").byteLength +
      encodeArchiveJson(inverted, "compact").byteLength) /
    events.length
  );
}

/** Removes the oldest chunks until their estimated archive share covers `overshootBytes`. */
function dropOldestChunks(plan: ExportPlan, overshootBytes: number): ChunkPlan[] {
  const blobsByHash = new Map(plan.blobs.map((blob) => [blob.hash, blob]));
  const blobUses = new Map<string, number>();

  for (const chunk of plan.chunks) {
    for (const hash of chunk.blobHashes) {
      blobUses.set(hash, (blobUses.get(hash) ?? 0) + 1);
    }
  }

  const indexBytes = plan.requestIndexBytes.byteLength + plan.invertedIndexBytes.byteLength;
  const eventCount = Math.max(1, plan.manifest.stats.eventCount);
  const targetBytes = overshootBytes * (1 + DROP_MARGIN_RATIO) + DROP_MARGIN_BYTES;
  let removedBytes = 0;
  let dropCount = 0;

  for (const chunk of plan.chunks) {
    if (removedBytes >= targetBytes) {
      break;
    }

    dropCount += 1;
    removedBytes +=
      encryptedEntryBytes(chunkArchivePath(chunk.meta.chunkId), chunk.exportMeta.byteLength) +
      Math.ceil((indexBytes * chunk.exportMeta.eventCount) / eventCount);

    for (const hash of chunk.blobHashes) {
      const uses = (blobUses.get(hash) ?? 0) - 1;
      const blob = blobsByHash.get(hash);

      blobUses.set(hash, uses);

      if (uses === 0 && blob) {
        removedBytes += encryptedEntryBytes(blobArchivePath(hash, blob.mime), blob.size);
      }
    }
  }

  return plan.chunks.slice(Math.max(1, dropCount));
}

function encryptedEntryBytes(path: string, plainBytes: number): number {
  return storeZipEntryBytes(path, plainBytes + AES_GCM_TAG_BYTES);
}

async function listChunkMetas(
  storage: PipelineStorage,
  sid: string
): Promise<ChunkTimeIndexEntry[]> {
  if (storage.listChunkMetas) {
    return storage.listChunkMetas(sid);
  }

  return (await storage.listChunks(sid)).map((chunk) => chunk.meta);
}

function buildManifest(
  context: SessionExportContext,
  chunks: ChunkTimeIndexEntry[],
  blobCount: number
): ExportManifest {
  const { session } = context;
  const first = chunks[0]?.tStart ?? session.startedAt;
  const last = chunks[chunks.length - 1]?.tEnd ?? session.startedAt;

  return {
    protocolVersion: ARCHIVE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    mode: session.mode,
    // The manifest stays readable even in encrypted archives, so the page title (which can
    // carry names, emails or document titles) is never written here.
    site: {
      origin: sanitizeUrlForPrivacy(session.url)
    },
    chunkCodec: chunks[0]?.codec ?? context.chunkCodec,
    redactionProfile: toManifestRedactionProfile(context.redactionProfile),
    stats: {
      eventCount: chunks.reduce((count, chunk) => count + chunk.eventCount, 0),
      chunkCount: chunks.length,
      blobCount,
      durationMs: Math.max(0, last - first)
    }
  };
}

/**
 * Copies only the schema-known redaction fields into the manifest. Profiles merged from stored
 * options can carry extra keys, which the strict manifest schema would reject on load.
 */
function toManifestRedactionProfile(profile: RedactionProfile | undefined): RedactionProfile {
  return {
    redactHeaders: [...(profile?.redactHeaders ?? [])],
    redactCookieNames: [...(profile?.redactCookieNames ?? [])],
    redactBodyPatterns: [...(profile?.redactBodyPatterns ?? [])],
    blockedSelectors: [...(profile?.blockedSelectors ?? [])],
    hashSensitiveValues: profile?.hashSensitiveValues ?? true
  };
}

function resolveExportPolicy(
  options: ExportBundleOptions,
  context: {
    latestEventTimestamp?: number;
    sessionStartedAt: number;
    sessionEndedAt?: number;
  }
): ResolvedExportPolicy {
  const includeScreenshots =
    typeof options.includeScreenshots === "boolean"
      ? options.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;
  const includeScreenRecordings =
    typeof options.includeScreenRecordings === "boolean"
      ? options.includeScreenRecordings
      : DEFAULT_EXPORT_POLICY.includeScreenRecordings;
  const maxArchiveBytes =
    options.maxArchiveBytes === null
      ? null
      : normalizeBoundedPositiveInt(
          options.maxArchiveBytes ?? DEFAULT_EXPORT_POLICY.maxArchiveBytes
        );
  const recentWindowMs =
    options.recentWindowMs === null
      ? null
      : normalizeBoundedPositiveInt(options.recentWindowMs ?? DEFAULT_EXPORT_POLICY.recentWindowMs);
  const anchorTimestamp =
    typeof context.sessionEndedAt === "number"
      ? Math.max(
          context.latestEventTimestamp ?? Number.NEGATIVE_INFINITY,
          context.sessionEndedAt,
          context.sessionStartedAt
        )
      : Math.max(
          Date.now(),
          context.latestEventTimestamp ?? Number.NEGATIVE_INFINITY,
          context.sessionStartedAt
        );
  const cutoffTimestamp =
    recentWindowMs === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(0, anchorTimestamp - recentWindowMs);

  return {
    includeScreenshots,
    includeScreenRecordings,
    maxArchiveBytes,
    recentWindowMs,
    cutoffTimestamp,
    filtersEvents: !includeScreenshots || !includeScreenRecordings || recentWindowMs !== null
  };
}

function shouldIncludeEvent(event: WebBlackboxEvent, policy: ResolvedExportPolicy): boolean {
  if (!policy.includeScreenshots && event.type === SCREENSHOT_EVENT_TYPE) {
    return false;
  }

  if (!policy.includeScreenRecordings && event.type.startsWith(SCREEN_RECORDING_EVENT_PREFIX)) {
    return false;
  }

  return event.t >= policy.cutoffTimestamp;
}

function buildExportTransferPolicy(
  capturePolicy: CapturePolicy | undefined,
  policy: ResolvedExportPolicy
): NonNullable<PrivacyManifest["transfer"]> {
  return {
    destination: "local-download",
    archiveKeyEnvelope: capturePolicy?.encryption.archiveKeyEnvelope ?? "passphrase",
    encrypted: true,
    includeScreenshots: policy.includeScreenshots,
    includeScreenRecordings: policy.includeScreenRecordings,
    maxArchiveBytes: policy.maxArchiveBytes,
    recentWindowMs: policy.recentWindowMs,
    shareEligible: true,
    computedAt: new Date().toISOString()
  };
}

function normalizeBoundedPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.round(value));
}
