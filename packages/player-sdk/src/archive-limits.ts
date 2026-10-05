import type JSZip from "jszip";

const MIB = 1024 * 1024;

/** `internalStream` exists on every JSZip 3 entry but is missing from its type declarations. */
type StreamableZipEntry = JSZip.JSZipObject & {
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
};

/**
 * Resource limits applied while opening an untrusted archive. Every byte the player
 * materializes from the archive (ZIP inflation and event-chunk codec decoding) is bounded.
 */
export type ArchiveLoadLimits = {
  /** Maximum number of ZIP entries (files and directories). */
  maxEntries: number;
  /** Maximum uncompressed size of a single ZIP entry, in bytes. */
  maxEntryUncompressedBytes: number;
  /** Maximum sum of all declared uncompressed ZIP entry sizes, in bytes. */
  maxTotalUncompressedBytes: number;
  /** Maximum decoded (gzip/br/zst) size of a single event chunk, in bytes. */
  maxDecodedChunkBytes: number;
  /** Maximum sum of decoded event chunk sizes held by an opened player, in bytes. */
  maxTotalDecodedChunkBytes: number;
};

/** Default archive load limits: 1 GiB total, 256 MiB per entry/chunk, 100k entries. */
export const DEFAULT_ARCHIVE_LOAD_LIMITS: Readonly<ArchiveLoadLimits> = Object.freeze({
  maxEntries: 100_000,
  maxEntryUncompressedBytes: 256 * MIB,
  maxTotalUncompressedBytes: 1024 * MIB,
  maxDecodedChunkBytes: 256 * MIB,
  maxTotalDecodedChunkBytes: 1024 * MIB
});

/** Thrown when an archive exceeds one of the configured {@link ArchiveLoadLimits}. */
export class ArchiveLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArchiveLimitError";
  }
}

const LIMIT_KEYS = Object.keys(DEFAULT_ARCHIVE_LOAD_LIMITS) as Array<keyof ArchiveLoadLimits>;

/** Merges caller overrides onto the defaults, rejecting non-positive or non-integer values. */
export function resolveArchiveLoadLimits(
  overrides: Partial<ArchiveLoadLimits> = {}
): ArchiveLoadLimits {
  const resolved: ArchiveLoadLimits = { ...DEFAULT_ARCHIVE_LOAD_LIMITS };

  for (const key of LIMIT_KEYS) {
    const value = overrides[key];

    if (value === undefined) {
      continue;
    }

    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`limits.${key} must be a positive integer, received ${String(value)}.`);
    }

    resolved[key] = value;
  }

  return resolved;
}

/**
 * Checks the ZIP central directory against the limits before any entry is inflated:
 * entry count, each declared uncompressed size, and the sum of declared sizes.
 */
export function assertArchiveWithinLimits(zip: JSZip, limits: ArchiveLoadLimits): void {
  const paths = Object.keys(zip.files);

  if (paths.length > limits.maxEntries) {
    throw new ArchiveLimitError(
      `Archive has ${paths.length} entries, more than the limit of ${limits.maxEntries}.`
    );
  }

  let totalBytes = 0;

  for (const path of paths) {
    const entry = zip.files[path];
    const declaredBytes = entry && !entry.dir ? readDeclaredUncompressedSize(entry) : null;

    if (declaredBytes === null) {
      continue;
    }

    if (declaredBytes > limits.maxEntryUncompressedBytes) {
      throw new ArchiveLimitError(
        `Archive entry '${path}' declares ${declaredBytes} uncompressed bytes, more than the ` +
          `per-entry limit of ${limits.maxEntryUncompressedBytes} bytes.`
      );
    }

    totalBytes += declaredBytes;

    if (totalBytes > limits.maxTotalUncompressedBytes) {
      throw new ArchiveLimitError(
        `Archive declares more than the total uncompressed limit of ` +
          `${limits.maxTotalUncompressedBytes} bytes.`
      );
    }
  }
}

/**
 * Inflates one ZIP entry while counting output bytes, aborting as soon as the output exceeds
 * the entry's declared size or the per-entry limit. Because {@link assertArchiveWithinLimits}
 * already bounded the sum of declared sizes, this also enforces the total limit during
 * inflation for archives whose central directory lies about entry sizes.
 */
export function readZipEntryBytes(
  entry: JSZip.JSZipObject,
  limits: Pick<ArchiveLoadLimits, "maxEntryUncompressedBytes">
): Promise<Uint8Array> {
  const declaredBytes = readDeclaredUncompressedSize(entry);
  const maxBytes =
    declaredBytes === null
      ? limits.maxEntryUncompressedBytes
      : Math.min(declaredBytes, limits.maxEntryUncompressedBytes);
  const limitMessage =
    declaredBytes !== null && declaredBytes <= limits.maxEntryUncompressedBytes
      ? `Archive entry '${entry.name}' inflates beyond its declared size of ${declaredBytes} bytes.`
      : `Archive entry '${entry.name}' exceeds the per-entry limit of ` +
        `${limits.maxEntryUncompressedBytes} bytes.`;

  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let settled = false;
    const stream = (entry as StreamableZipEntry).internalStream("uint8array");

    stream.on("data", (chunk: Uint8Array) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        settled = true;
        stream.pause();
        reject(new ArchiveLimitError(limitMessage));
        return;
      }

      chunks.push(chunk);
    });
    stream.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(concatBytes(chunks, totalBytes));
      }
    });
    stream.resume();
  });
}

/** Concatenates byte chunks whose combined length is already known. */
export function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === totalBytes) {
    return chunks[0];
  }

  const output = new Uint8Array(totalBytes);
  let cursor = 0;

  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  return output;
}

/**
 * Reads the uncompressed size recorded in the central directory. JSZip keeps it on the
 * private `_data` compressed-object; returns null when unavailable (e.g. entries added in memory).
 * The value is untrusted: inflation is still capped by {@link readZipEntryBytes}.
 */
function readDeclaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: unknown })._data;

  if (typeof data !== "object" || data === null) {
    return null;
  }

  const size = (data as { uncompressedSize?: unknown }).uncompressedSize;

  if (typeof size !== "number" || !Number.isSafeInteger(size)) {
    return null;
  }

  // JSZip assembles 32-bit header fields with signed shifts, so sizes >= 2 GiB come back negative.
  return size < 0 ? size >>> 0 : size;
}
