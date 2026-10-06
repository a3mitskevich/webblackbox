import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { makeWebmSeekable } from "./webm-seekable.js";

/** One stored chunk of a tab video, in recording order. */
export type ScreenRecordingChunkRef = {
  index: number;
  /** Blob hash of the chunk in the archive. */
  chunkId: string;
  size?: number;
};

/**
 * One tab video segment (one `recordingId`): a recording restarts as a new segment, so a session
 * can hold several.
 */
export type ScreenRecordingSegment = {
  recordingId: string;
  /** 1-based position among the session's segments, in start order. */
  part: number;
  source: string | null;
  /** As recorded, e.g. `video/webm;codecs=vp9`. */
  mime: string;
  startMono: number;
  endMono: number;
  durationMs: number;
  /** Bytes of the recording's chunks. */
  size: number;
  width?: number;
  height?: number;
  /** Chunks the recording produced. */
  chunkCount: number;
  /** Chunks the archive references, by index. */
  chunks: ScreenRecordingChunkRef[];
  /** Indices of chunks no event references (the video cannot be assembled). */
  missingChunks: number[];
  /** The recording has its `screen.recording.end` event. */
  ended: boolean;
  endReason?: string;
};

/** A missing chunk: not referenced by any event (`chunkId: null`), or its blob is not stored. */
export type MissingScreenRecordingChunk = { index: number; chunkId: string | null };

/** The video of a recording cannot be assembled because chunks are missing. */
export class ScreenRecordingIncompleteError extends Error {
  public readonly recordingId: string;

  public readonly chunkCount: number;

  public readonly missing: MissingScreenRecordingChunk[];

  public constructor(
    recordingId: string,
    chunkCount: number,
    missing: MissingScreenRecordingChunk[]
  ) {
    const indices = missing.map((entry) => entry.index).join(", ");
    super(
      `Screen recording ${recordingId} is incomplete: ${missing.length} of ${chunkCount} chunks ` +
        `are missing from the archive (index ${indices}).`
    );
    this.name = "ScreenRecordingIncompleteError";
    this.recordingId = recordingId;
    this.chunkCount = chunkCount;
    this.missing = missing;
  }
}

/** The assembled video of one segment. */
export type ScreenRecordingBlob = {
  recordingId: string;
  bytes: Uint8Array;
  mime: string;
  /**
   * Length of the media: from the frame timestamps when the container was fixed, else the
   * recorded duration.
   */
  durationMs: number;
  /** The WebM got a Duration and Cues (players show its length and seek). */
  seekable: boolean;
};

export type ScreenRecordingBlobOptions = {
  /** The chunks joined as recorded, without fixing the container (default `false`). */
  raw?: boolean;
};

type RecordingParts = {
  recordingId: string;
  start?: WebBlackboxEvent;
  end?: WebBlackboxEvent;
  chunkEvents: WebBlackboxEvent[];
};

const RECORDING_EVENT_TYPES = new Set([
  "screen.recording.start",
  "screen.recording.chunk",
  "screen.recording.end"
]);
const DEFAULT_VIDEO_MIME = "video/webm";

/**
 * The tab video segments of a session, in start order. The chunk order comes from the chunk
 * events' `index`; the end event's `chunks` list fills in indices whose chunk events are gone
 * only when that list has no holes (it lists stored chunks only, so a hole would shift it).
 */
export function listScreenRecordings(
  events: readonly WebBlackboxEvent[]
): ScreenRecordingSegment[] {
  const byId = new Map<string, RecordingParts>();

  for (const event of events) {
    if (!RECORDING_EVENT_TYPES.has(event.type)) {
      continue;
    }

    const recordingId = asString(asRecord(event.data)?.recordingId);

    if (!recordingId) {
      continue;
    }

    const parts = byId.get(recordingId) ?? { recordingId, chunkEvents: [] };
    byId.set(recordingId, parts);

    if (event.type === "screen.recording.start") {
      parts.start ??= event;
    } else if (event.type === "screen.recording.end") {
      parts.end ??= event;
    } else {
      parts.chunkEvents.push(event);
    }
  }

  return [...byId.values()]
    .flatMap((parts) => {
      const segment = buildSegment(parts);
      return segment ? [segment] : [];
    })
    .sort(
      (left, right) =>
        left.startMono - right.startMono || left.recordingId.localeCompare(right.recordingId)
    )
    .map((segment, index) => ({ ...segment, part: index + 1 }));
}

type ChunkScan = {
  byIndex: Map<number, ScreenRecordingChunkRef>;
  firstMono: number | null;
  lastMono: number | null;
};

function scanChunkEvents(chunkEvents: readonly WebBlackboxEvent[]): ChunkScan {
  const scan: ChunkScan = { byIndex: new Map(), firstMono: null, lastMono: null };

  for (const event of chunkEvents) {
    const data = asRecord(event.data);
    const index = asIndex(data?.index);
    const chunkId = asString(data?.chunkId);

    if (index === null || !chunkId || scan.byIndex.has(index)) {
      continue;
    }

    const size = asIndex(data?.size);
    scan.byIndex.set(index, size === null ? { index, chunkId } : { index, chunkId, size });
    scan.firstMono = Math.min(scan.firstMono ?? event.mono, event.mono);
    scan.lastMono = Math.max(scan.lastMono ?? event.mono, event.mono);
  }

  return scan;
}

function buildSegment(parts: RecordingParts): ScreenRecordingSegment | null {
  const startData = asRecord(parts.start?.data);
  const endData = asRecord(parts.end?.data);
  const { byIndex, firstMono, lastMono } = scanChunkEvents(parts.chunkEvents);
  const listed = asStringList(endData?.chunks);
  const chunkCount = Math.max(
    Math.max(-1, ...byIndex.keys()) + 1,
    listed.length,
    asIndex(endData?.chunkCount) ?? 0
  );

  if (chunkCount === 0) {
    return null;
  }

  // The end list maps onto indices only when it is complete and agrees with the chunk events.
  if (
    listed.length === chunkCount &&
    [...byIndex.values()].every((chunk) => listed[chunk.index] === chunk.chunkId)
  ) {
    listed.forEach((chunkId, index) => {
      if (!byIndex.has(index)) {
        byIndex.set(index, { index, chunkId });
      }
    });
  }

  const chunks = [...byIndex.values()].sort((left, right) => left.index - right.index);
  const missingChunks = Array.from({ length: chunkCount }, (_, index) => index).filter(
    (index) => !byIndex.has(index)
  );
  const recordedDuration = asIndex(endData?.durationMs) ?? 0;
  const startMono =
    parts.start?.mono ?? firstMono ?? (parts.end ? parts.end.mono - recordedDuration : 0);
  const endMono = Math.max(startMono, parts.end?.mono ?? lastMono ?? startMono);
  const chunkBytes = chunks.reduce((total, chunk) => total + (chunk.size ?? 0), 0);
  const width = asIndex(endData?.width) ?? asIndex(startData?.width);
  const height = asIndex(endData?.height) ?? asIndex(startData?.height);
  const endReason = asString(endData?.reason);

  return {
    recordingId: parts.recordingId,
    part: 0,
    source: asString(startData?.source),
    mime:
      asString(startData?.mime) ??
      asString(endData?.mime) ??
      asString(asRecord(parts.chunkEvents[0]?.data)?.mime) ??
      DEFAULT_VIDEO_MIME,
    startMono,
    endMono,
    durationMs: recordedDuration > 0 ? recordedDuration : Math.round(endMono - startMono),
    size: Math.max(chunkBytes, asIndex(endData?.size) ?? 0),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    chunkCount,
    chunks,
    missingChunks,
    ended: Boolean(parts.end),
    ...(endReason ? { endReason } : {})
  };
}

/**
 * Joins a segment's chunks in index order and, for WebM, fixes the container so that players
 * show the duration and seek. Throws {@link ScreenRecordingIncompleteError} naming every chunk
 * that is not referenced or not stored.
 */
export async function assembleScreenRecording(
  segment: ScreenRecordingSegment,
  getBlob: (chunkId: string) => Promise<{ bytes: Uint8Array } | null>,
  options: ScreenRecordingBlobOptions = {}
): Promise<ScreenRecordingBlob> {
  const missing: MissingScreenRecordingChunk[] = segment.missingChunks.map((index) => ({
    index,
    chunkId: null
  }));
  const parts: Uint8Array[] = [];

  for (const chunk of segment.chunks) {
    const blob = await getBlob(chunk.chunkId);

    if (blob) {
      parts.push(blob.bytes);
    } else {
      missing.push({ index: chunk.index, chunkId: chunk.chunkId });
    }
  }

  if (missing.length > 0) {
    throw new ScreenRecordingIncompleteError(
      segment.recordingId,
      segment.chunkCount,
      [...missing].sort((left, right) => left.index - right.index)
    );
  }

  const joined = concatBytes(parts);
  const fixed = options.raw || !isWebm(segment.mime) ? null : makeWebmSeekable(joined);

  return {
    recordingId: segment.recordingId,
    bytes: fixed?.bytes ?? joined,
    mime: segment.mime,
    durationMs: fixed?.durationMs ?? segment.durationMs,
    seekable: fixed !== null
  };
}

function isWebm(mime: string): boolean {
  return /^(video|audio)\/webm\b/i.test(mime);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
    ? (value as string[])
    : [];
}

/** A non-negative integer, or `null`. */
function asIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
