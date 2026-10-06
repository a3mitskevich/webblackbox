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
import { computeChunkTimeBounds, EventChunker } from "./chunker.js";
import { concatBytes } from "./exporter.js";
import { sha256Hex } from "./hash.js";
import type { EventIndexer } from "./indexer.js";
import {
  type ArchiveExportResult,
  buildSessionIndexes,
  type ExportBundleOptions,
  exportSessionArchive
} from "./session-export.js";
import type { PipelineStorage, StoredBlob, StoredChunk } from "./storage.js";
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

  public async ingest(event: WebBlackboxEvent): Promise<void> {
    assertPrivacyClassifiedEvent(event);
    const chunk = await this.chunker.append(await this.externalizeLargePayload(event));

    if (!chunk) {
      return;
    }

    await this.persistChunk(
      chunk.meta.chunkId,
      chunk.meta.seq,
      chunk.meta.codec,
      chunk.events,
      chunk.bytes
    );
  }

  public async ingestBatch(events: WebBlackboxEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      assertPrivacyClassifiedEvent(event);
    }

    for (const event of events) {
      const chunk = await this.chunker.append(await this.externalizeLargePayload(event));

      if (!chunk) {
        continue;
      }

      await this.persistChunk(
        chunk.meta.chunkId,
        chunk.meta.seq,
        chunk.meta.codec,
        chunk.events,
        chunk.bytes
      );
    }
  }

  public async flush(): Promise<void> {
    const chunk = await this.chunker.flush();

    if (!chunk) {
      return;
    }

    await this.persistChunk(
      chunk.meta.chunkId,
      chunk.meta.seq,
      chunk.meta.codec,
      chunk.events,
      chunk.bytes
    );
  }

  public async close(options: { purge?: boolean } = {}): Promise<void> {
    await this.flush();

    if (options.purge) {
      await this.options.storage.deleteSession(this.options.session.sid);
    }
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

  private async persistChunk(
    chunkId: string,
    seq: number,
    codec: (typeof CHUNK_CODECS)[number],
    events: WebBlackboxEvent[],
    bytes: Uint8Array
  ): Promise<void> {
    const hash = await sha256Hex(bytes);

    const chunk: StoredChunk = {
      sid: this.options.session.sid,
      meta: {
        chunkId,
        seq,
        ...computeChunkTimeBounds(events),
        eventCount: events.length,
        byteLength: bytes.byteLength,
        codec,
        sha256: hash
      },
      bytes
    };

    await this.options.storage.putChunk(chunk);
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
