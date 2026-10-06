import type {
  CapturePolicy,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RedactionProfile,
  RequestIndexEntry,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { assertExportPassphrase, CHUNK_CODECS } from "@webblackbox/protocol";

import type { ArchiveSink } from "./archive-writer.js";
import { EventChunker, type FinalizedChunk } from "./chunker.js";
import { concatBytes } from "./exporter.js";
import { sha256Hex } from "./hash.js";
import type { EventIndexer } from "./indexer.js";
import {
  type ArchiveExportResult,
  buildSessionIndexes,
  type ExportBundleOptions,
  exportSessionArchive
} from "./session-export.js";
import type { PipelineStorage, StoredBlob } from "./storage.js";
import { externalizeStreamPayload } from "./stream-payload.js";

export type { ArchiveExportResult, ExportBundleOptions } from "./session-export.js";

export type FlightRecorderPipelineOptions = {
  session: SessionMetadata;
  storage: PipelineStorage;
  maxChunkBytes?: number;
  chunkCodec?: (typeof CHUNK_CODECS)[number];
  redactionProfile?: RedactionProfile;
  capturePolicy?: CapturePolicy;
};

export type ExportResult = {
  fileName: string;
  bytes: Uint8Array;
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest;
};

export class FlightRecorderPipeline {
  private readonly chunker: EventChunker;
  private readonly chunkCodec: (typeof CHUNK_CODECS)[number];

  public constructor(private readonly options: FlightRecorderPipelineOptions) {
    const codec = resolveChunkCodec(options.chunkCodec);
    const maxChunkBytes = options.maxChunkBytes ?? 512 * 1024;
    this.chunkCodec = codec;
    this.chunker = new EventChunker(maxChunkBytes, codec);
  }

  public async start(): Promise<void> {
    const lastSequence =
      (await this.options.storage.getLatestChunkMeta(this.options.session.sid))?.seq ?? 0;

    this.chunker.restoreSequence(lastSequence);
    await this.options.storage.putSession(this.options.session);
  }

  /** Ingests one event; resolves to the UTF-8 bytes of its stored NDJSON line. */
  public async ingest(event: WebBlackboxEvent): Promise<number> {
    assertPrivacyClassifiedEvent(event);
    return this.appendEvent(event);
  }

  /** Ingests events in order; resolves to the UTF-8 bytes of their stored NDJSON lines. */
  public async ingestBatch(events: WebBlackboxEvent[]): Promise<number> {
    for (const event of events) {
      assertPrivacyClassifiedEvent(event);
    }

    let bytes = 0;

    for (const event of events) {
      bytes += await this.appendEvent(event);
    }

    return bytes;
  }

  public async flush(): Promise<void> {
    const chunk = await this.chunker.flush();

    if (chunk) {
      await this.persistChunk(chunk);
    }
  }

  public async close(options: { purge?: boolean } = {}): Promise<void> {
    await this.flush();

    if (options.purge) {
      await this.options.storage.deleteSession(this.options.session.sid);
    }
  }

  private async appendEvent(event: WebBlackboxEvent): Promise<number> {
    const appended = await this.chunker.append(await this.externalizeLargePayload(event));

    if (appended.chunk) {
      await this.persistChunk(appended.chunk);
    }

    return appended.bytes;
  }

  /** Large WebSocket/SSE text goes to a blob so event chunks stay small (see `stream-payload.ts`). */
  private externalizeLargePayload(event: WebBlackboxEvent): Promise<WebBlackboxEvent> {
    return externalizeStreamPayload(event, (mime, bytes) => this.putBlob(mime, bytes));
  }

  public async putBlob(mime: string, bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    const blob: StoredBlob = {
      hash,
      mime,
      size: bytes.byteLength,
      bytes,
      createdAt: Date.now(),
      refCount: 1
    };

    await this.options.storage.putBlob(blob, this.options.session.sid);
    return hash;
  }

  public async finalizeIndexes(): Promise<{
    time: ReturnType<EventIndexer["snapshot"]>["time"];
    request: RequestIndexEntry[];
    inverted: InvertedIndexEntry[];
  }> {
    await this.flush();
    const snapshot = await buildSessionIndexes(this.options.storage, this.options.session.sid);
    await this.options.storage.putIndexes(this.options.session.sid, snapshot);
    return snapshot;
  }

  /**
   * Streams the session's archive into `sink` (one chunk or blob in memory at a time) under the
   * export policy; see `exportSessionArchive`.
   */
  public async exportArchive(
    sink: ArchiveSink,
    options: ExportBundleOptions = {}
  ): Promise<ArchiveExportResult> {
    // The scanner only reports findings; encryption is mandatory for every archive.
    assertExportPassphrase(options.passphrase);
    await this.flush();

    return exportSessionArchive(
      {
        storage: this.options.storage,
        session: this.options.session,
        chunkCodec: this.chunkCodec,
        redactionProfile: this.options.redactionProfile,
        capturePolicy: this.options.capturePolicy
      },
      options,
      sink
    );
  }

  /** The archive as one byte array; `exportArchive` avoids holding it whole. */
  public async exportBundle(options: ExportBundleOptions = {}): Promise<ExportResult> {
    const parts: Uint8Array[] = [];
    const exported = await this.exportArchive((part) => {
      parts.push(part);
    }, options);

    return {
      fileName: exported.fileName,
      bytes: concatBytes(parts),
      integrity: exported.integrity,
      privacyManifest: exported.privacyManifest
    };
  }

  /** The chunker already hashed the bytes and computed the time bounds. */
  private async persistChunk(chunk: FinalizedChunk): Promise<void> {
    await this.options.storage.putChunk({
      sid: this.options.session.sid,
      meta: chunk.meta,
      bytes: chunk.bytes
    });
  }
}

function assertPrivacyClassifiedEvent(event: WebBlackboxEvent): void {
  if (!event.privacy) {
    throw new Error(`Event ${event.id} is missing privacy classification.`);
  }
}

function resolveChunkCodec(
  codec: (typeof CHUNK_CODECS)[number] | undefined
): (typeof CHUNK_CODECS)[number] {
  if (!codec) {
    return "none";
  }

  return CHUNK_CODECS.includes(codec) ? codec : "none";
}
