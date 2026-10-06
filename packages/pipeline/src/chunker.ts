import type { ChunkCodec, ChunkTimeIndexEntry, WebBlackboxEvent } from "@webblackbox/protocol";

import { createChunkId } from "@webblackbox/protocol";

import { encodeChunkBytes } from "./codec.js";
import { sha256Hex } from "./hash.js";

export type FinalizedChunk = {
  meta: ChunkTimeIndexEntry;
  bytes: Uint8Array;
  events: WebBlackboxEvent[];
};

/** What one appended event cost: its NDJSON line in UTF-8 bytes, without the separator. */
export type ChunkAppendResult = {
  chunk: FinalizedChunk | null;
  bytes: number;
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

/**
 * Groups events into NDJSON chunks. Each event is serialized once, on append: the line is kept
 * and reused for the chunk size, the caller's byte count and the chunk bytes.
 */
export class EventChunker {
  private readonly pending: WebBlackboxEvent[] = [];

  private readonly pendingLines: string[] = [];

  private pendingBytes = 0;

  private sequence = 0;

  public constructor(
    private readonly maxChunkBytes: number,
    private readonly codec: ChunkCodec
  ) {}

  public async append(event: WebBlackboxEvent): Promise<ChunkAppendResult> {
    const line = JSON.stringify(event);

    this.pending.push(event);
    this.pendingLines.push(line);
    // The threshold counts UTF-16 units plus the separator, as before, so chunk boundaries stay put.
    this.pendingBytes += line.length + 1;

    const bytes = utf8ByteLength(line);

    if (this.pendingBytes < this.maxChunkBytes) {
      return { chunk: null, bytes };
    }

    return { chunk: await this.finalize(), bytes };
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
    const ndjson = new TextEncoder().encode(this.pendingLines.join("\n"));
    const encoded = await encodeChunkBytes(ndjson, this.codec);
    const bytes = encoded.bytes;
    const hash = await sha256Hex(bytes);

    this.pending.length = 0;
    this.pendingLines.length = 0;
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

/** UTF-8 length of a string without encoding it (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
