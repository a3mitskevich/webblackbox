import type { ArchiveSink } from "./zip-writer.js";

export type ArchiveBlobSink = {
  readonly sink: ArchiveSink;
  /** Bytes received so far. */
  readonly size: number;
  toBlob(type?: string): Blob;
};

const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;

/**
 * Collects a streamed archive into a `Blob`. Parts are folded into Blob segments every
 * `segmentBytes`, so the browser can keep (and page out) the data in its blob store instead of
 * the page holding every part as an ArrayBuffer until the end.
 */
export function createArchiveBlobSink(segmentBytes = DEFAULT_SEGMENT_BYTES): ArchiveBlobSink {
  const segments: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size = 0;

  const flushPending = (): void => {
    if (pending.length === 0) {
      return;
    }

    segments.push(new Blob(pending as BlobPart[]));
    pending = [];
    pendingBytes = 0;
  };

  return {
    sink: (part) => {
      pending.push(part);
      pendingBytes += part.byteLength;
      size += part.byteLength;

      if (pendingBytes >= segmentBytes) {
        flushPending();
      }
    },
    get size() {
      return size;
    },
    toBlob: (type = "application/zip") => {
      flushPending();
      return new Blob(segments, { type });
    }
  };
}
