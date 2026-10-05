import type { ChunkCodec, ChunkTimeIndexEntry, WebBlackboxEvent } from "@webblackbox/protocol";

import { createChunkId } from "@webblackbox/protocol";

import { encodeChunkEvents } from "./codec.js";
import { sha256Hex } from "./hash.js";

export type FinalizedChunk = {
  meta: ChunkTimeIndexEntry;
  bytes: Uint8Array;
  events: WebBlackboxEvent[];
};

export type ChunkTimeBounds = Pick<
  ChunkTimeIndexEntry,
  "tStart" | "tEnd" | "monoStart" | "monoEnd"
>;

const EMPTY_CHUNK_TIME_BOUNDS: ChunkTimeBounds = { tStart: 0, tEnd: 0, monoStart: 0, monoEnd: 0 };

/**
 * Min/max wall-clock and monotonic time of a chunk's events. Chunks keep events in arrival order,
 * which is not time order (page-side events arrive late), so the first and last event would
 * understate the span and make readers skip the chunk for ranges it does cover.
 */
export function computeChunkTimeBounds(
  events: WebBlackboxEvent[],
  fallback: ChunkTimeBounds = EMPTY_CHUNK_TIME_BOUNDS
): ChunkTimeBounds {
  if (events.length === 0) {
    const { tStart, tEnd, monoStart, monoEnd } = fallback;
    return { tStart, tEnd, monoStart, monoEnd };
  }

  let tStart = Number.POSITIVE_INFINITY;
  let tEnd = Number.NEGATIVE_INFINITY;
  let monoStart = Number.POSITIVE_INFINITY;
  let monoEnd = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    tStart = Math.min(tStart, event.t);
    tEnd = Math.max(tEnd, event.t);
    monoStart = Math.min(monoStart, event.mono);
    monoEnd = Math.max(monoEnd, event.mono);
  }

  return { tStart, tEnd, monoStart, monoEnd };
}

export class EventChunker {
  private readonly pending: WebBlackboxEvent[] = [];

  private pendingBytes = 0;

  private sequence = 0;

  public constructor(
    private readonly maxChunkBytes: number,
    private readonly codec: ChunkCodec
  ) {}

  public async append(event: WebBlackboxEvent): Promise<FinalizedChunk | null> {
    this.pending.push(event);
    this.pendingBytes += estimateEventNdjsonBytes(event);

    if (this.pendingBytes < this.maxChunkBytes) {
      return null;
    }

    return this.finalize();
  }

  public async flush(): Promise<FinalizedChunk | null> {
    if (this.pending.length === 0) {
      return null;
    }

    return this.finalize();
  }

  public restoreSequence(sequence: number): void {
    if (!Number.isFinite(sequence) || sequence <= this.sequence) {
      return;
    }

    this.sequence = Math.floor(sequence);
  }

  private async finalize(): Promise<FinalizedChunk> {
    this.sequence += 1;

    const events = [...this.pending];
    const encoded = await encodeChunkEvents(events, this.codec);
    const bytes = encoded.bytes;
    const hash = await sha256Hex(bytes);

    this.pending.length = 0;
    this.pendingBytes = 0;

    return {
      meta: {
        chunkId: createChunkId(this.sequence),
        seq: this.sequence,
        ...computeChunkTimeBounds(events),
        eventCount: events.length,
        byteLength: bytes.byteLength,
        codec: encoded.codec,
        sha256: hash
      },
      bytes,
      events
    };
  }
}

function estimateEventNdjsonBytes(event: WebBlackboxEvent): number {
  return JSON.stringify(event).length + 1;
}
