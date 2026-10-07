import type { ChunkCodec } from "@webblackbox/protocol";

import { cloneBytes, toArrayBuffer } from "./archive-crypto.js";
import { ArchiveLimitError, type ArchiveLoadLimits, concatBytes } from "./archive-limits.js";

type NodeZlibDecodeOptions = {
  maxOutputLength: number;
};

type NodeZlibLike = {
  gunzipSync?: (input: Uint8Array, options?: NodeZlibDecodeOptions) => Uint8Array;
  brotliDecompressSync?: (input: Uint8Array, options?: NodeZlibDecodeOptions) => Uint8Array;
  zstdDecompressSync?: (input: Uint8Array, options?: NodeZlibDecodeOptions) => Uint8Array;
};

type ChunkDecodeLimit = {
  maxBytes: number;
  message: string;
};

const STREAM_CODEC_TIMEOUT_MS = 5_000;

export function resolveChunkDecodeLimit(
  path: string,
  codec: ChunkCodec,
  limits: ArchiveLoadLimits,
  decodedTotalBytes: number
): ChunkDecodeLimit {
  const remainingTotalBytes = limits.maxTotalDecodedChunkBytes - decodedTotalBytes;

  if (remainingTotalBytes < limits.maxDecodedChunkBytes) {
    return {
      maxBytes: Math.max(0, remainingTotalBytes),
      message:
        `Archive event chunk '${path}' (${codec}) exceeds the total decoded limit of ` +
        `${limits.maxTotalDecodedChunkBytes} bytes.`
    };
  }

  return {
    maxBytes: limits.maxDecodedChunkBytes,
    message:
      `Archive event chunk '${path}' (${codec}) exceeds the per-chunk decoded limit of ` +
      `${limits.maxDecodedChunkBytes} bytes.`
  };
}

export async function decodeChunkBytes(
  bytes: Uint8Array,
  codec: ChunkCodec,
  limit: ChunkDecodeLimit
): Promise<Uint8Array> {
  if (codec === "none") {
    if (bytes.byteLength > limit.maxBytes) {
      throw new ArchiveLimitError(limit.message);
    }

    return bytes;
  }

  const fromStreams = await tryDecodeChunkWithStreams(bytes, codec, limit);

  if (fromStreams) {
    return fromStreams;
  }

  const fromNodeZlib = await tryDecodeChunkWithNodeZlib(bytes, codec, limit);

  if (fromNodeZlib) {
    return fromNodeZlib;
  }

  throw new Error(`Archive chunk codec '${codec}' is not supported in this runtime.`);
}

async function tryDecodeChunkWithStreams(
  bytes: Uint8Array,
  codec: ChunkCodec,
  limit: ChunkDecodeLimit
): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined" || typeof Blob === "undefined") {
    return null;
  }

  for (const format of codecFormats(codec)) {
    try {
      const stream = new Blob([toArrayBuffer(bytes)])
        .stream()
        .pipeThrough(new DecompressionStream(format as CompressionFormat));
      return await readReadableStreamWithTimeout(stream, codec, format, limit);
    } catch (error) {
      if (error instanceof ArchiveLimitError) {
        throw error;
      }

      continue;
    }
  }

  return null;
}

async function readReadableStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: ChunkDecodeLimit
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalLength += chunk.byteLength;

    if (totalLength > limit.maxBytes) {
      throw new ArchiveLimitError(limit.message);
    }

    chunks.push(chunk);
  }

  return concatBytes(chunks, totalLength);
}

async function readReadableStreamWithTimeout(
  stream: ReadableStream<Uint8Array>,
  codec: ChunkCodec,
  format: string,
  limit: ChunkDecodeLimit
): Promise<Uint8Array> {
  const reader = stream.getReader();

  try {
    return await withTimeout(
      readReadableStream(reader, limit),
      STREAM_CODEC_TIMEOUT_MS,
      `Chunk codec '${codec}' decode timed out for format '${format}'.`
    );
  } catch (error) {
    // Stop the decompressor so an abandoned (over-limit or timed-out) decode frees its memory.
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function tryDecodeChunkWithNodeZlib(
  bytes: Uint8Array,
  codec: ChunkCodec,
  limit: ChunkDecodeLimit
): Promise<Uint8Array | null> {
  const zlib = await loadNodeZlib();

  if (!zlib) {
    return null;
  }

  if (limit.maxBytes < 1) {
    throw new ArchiveLimitError(limit.message);
  }

  const options: NodeZlibDecodeOptions = { maxOutputLength: limit.maxBytes };

  try {
    if (codec === "gzip" && typeof zlib.gunzipSync === "function") {
      return cloneBytes(zlib.gunzipSync(bytes, options));
    }

    if (codec === "br" && typeof zlib.brotliDecompressSync === "function") {
      return cloneBytes(zlib.brotliDecompressSync(bytes, options));
    }

    if (codec === "zst" && typeof zlib.zstdDecompressSync === "function") {
      return cloneBytes(zlib.zstdDecompressSync(bytes, options));
    }
  } catch (error) {
    if (isNodeBufferTooLargeError(error)) {
      throw new ArchiveLimitError(limit.message);
    }

    return null;
  }

  return null;
}

function isNodeBufferTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

async function loadNodeZlib(): Promise<NodeZlibLike | null> {
  if (
    typeof process === "undefined" ||
    typeof process.versions !== "object" ||
    typeof process.versions?.node !== "string"
  ) {
    return null;
  }

  try {
    const module = await import("node:zlib");
    return module as unknown as NodeZlibLike;
  } catch {
    return null;
  }
}

function codecFormats(codec: ChunkCodec): string[] {
  if (codec === "gzip") {
    return ["gzip"];
  }

  if (codec === "br") {
    return ["brotli", "br"];
  }

  if (codec === "zst") {
    return ["zstd", "zst"];
  }

  return [];
}
