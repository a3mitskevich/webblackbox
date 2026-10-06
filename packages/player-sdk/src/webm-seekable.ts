/**
 * Makes a live WebM (Chrome MediaRecorder output: a Segment and Clusters of unknown size, no
 * Duration, no Cues) seekable without re-encoding: the container is rewritten with a known Segment
 * size, a SeekHead, a Duration in Info and a Cues index, while every frame stays byte-for-byte the
 * same. Players then show the length and seek without scanning the file.
 */

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
  referenceBlock: 0xfb,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  void: 0xec,
  crc32: 0xbf
} as const;

/** Children a Cluster of unknown size may hold; any other id ends it. */
const CLUSTER_CHILD_IDS = new Set<number>([
  ID.timecode,
  0x5854, // SilentTracks
  0xa7, // Position
  0xab, // PrevSize
  ID.simpleBlock,
  ID.blockGroup,
  0xaf, // EncryptedBlock
  ID.void,
  ID.crc32
]);

/** Top-level elements that are rebuilt (positions change) or dropped. */
const REBUILT_IDS = new Set<number>([ID.seekHead, ID.cues, ID.void, ID.crc32]);

const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const TRACK_TYPE_VIDEO = 1;
/** Size fields written by this module are 8 bytes long, so layouts never depend on values. */
const SIZE_FIELD_LENGTH = 8;
/** A frame gap above this is a pause, not the frame rate. */
const MAX_FRAME_GAP_MS = 1_000;

export type WebmSeekableResult = {
  bytes: Uint8Array;
  /** Length of the media from the block timestamps, in milliseconds. */
  durationMs: number;
  /** Cue points written (one per cluster with a key frame of the cue track). */
  cueCount: number;
};

type ElementHeader = {
  id: number;
  /** `null` = unknown size. */
  size: number | null;
  /** Offset of the element's data. */
  dataStart: number;
  sizeFieldStart: number;
  sizeFieldLength: number;
};

type ByteRange = { start: number; end: number; dataStart: number };

type ClusterInfo = {
  start: number;
  end: number;
  sizeFieldStart: number;
  sizeFieldLength: number;
  headerLength: number;
  timecode: number;
  /** Absolute time of the first key frame per track number. */
  keyFrames: Map<number, number>;
};

type ParsedWebm = {
  ebmlHeader: Uint8Array;
  info: ByteRange | null;
  tracks: ByteRange | null;
  others: ByteRange[];
  clusters: ClusterInfo[];
  timecodeScale: number;
  /** Block times per track, in stream order. */
  blockTimes: Map<number, number[]>;
  /** Latest block end known from a BlockDuration. */
  maxBlockEnd: number;
  videoTrack: number | null;
};

/** The bytes end inside an element: the recording was cut there. */
class TruncatedError extends Error {}

/**
 * Rewrites a WebM so that it has a Duration and Cues. Returns `null` when the bytes are not a
 * WebM/Matroska stream this module understands; the caller keeps the original bytes then.
 */
export function makeWebmSeekable(bytes: Uint8Array): WebmSeekableResult | null {
  try {
    const parsed = parseWebm(bytes);
    return parsed ? writeSeekableWebm(bytes, parsed) : null;
  } catch {
    return null;
  }
}

function parseWebm(bytes: Uint8Array): ParsedWebm | null {
  const ebml = readElementHeader(bytes, 0);

  if (ebml.id !== ID.ebml || ebml.size === null) {
    return null;
  }

  const ebmlEnd = ebml.dataStart + ebml.size;
  const segment = readElementHeader(bytes, ebmlEnd);

  if (segment.id !== ID.segment) {
    return null;
  }

  const segmentEnd =
    segment.size === null ? bytes.length : Math.min(bytes.length, segment.dataStart + segment.size);
  const parsed: ParsedWebm = {
    ebmlHeader: bytes.subarray(0, ebmlEnd),
    info: null,
    tracks: null,
    others: [],
    clusters: [],
    timecodeScale: DEFAULT_TIMECODE_SCALE_NS,
    blockTimes: new Map(),
    maxBlockEnd: 0,
    videoTrack: null
  };
  let position = segment.dataStart;

  while (position < segmentEnd) {
    const header = readHeaderOrNull(bytes, position);

    if (!header) {
      break;
    }

    if (header.id === ID.cluster) {
      const cluster = readCluster(bytes, position, header, segmentEnd, parsed);

      if (!cluster) {
        break;
      }

      parsed.clusters.push(cluster);
      position = cluster.end;
      continue;
    }

    if (header.size === null) {
      return null;
    }

    const range = {
      start: position,
      end: header.dataStart + header.size,
      dataStart: header.dataStart
    };

    if (range.end > segmentEnd) {
      // A cut-off element after the media: drop it.
      break;
    }

    if (header.id === ID.info) {
      parsed.info = range;
      parsed.timecodeScale = readTimecodeScale(bytes, range);
    } else if (header.id === ID.tracks) {
      parsed.tracks = range;
      parsed.videoTrack = readVideoTrack(bytes, range);
    } else if (!REBUILT_IDS.has(header.id)) {
      parsed.others.push(range);
    }

    position = range.end;
  }

  return parsed.info && parsed.tracks && parsed.blockTimes.size > 0 ? parsed : null;
}

/** The element header at `position`, or `null` when the bytes end inside it. */
function readHeaderOrNull(bytes: Uint8Array, position: number): ElementHeader | null {
  try {
    return readElementHeader(bytes, position);
  } catch (error) {
    if (error instanceof TruncatedError) {
      return null;
    }

    throw error;
  }
}

function readCluster(
  bytes: Uint8Array,
  start: number,
  header: ElementHeader,
  segmentEnd: number,
  parsed: ParsedWebm
): ClusterInfo | null {
  const limit =
    header.size === null ? segmentEnd : Math.min(segmentEnd, header.dataStart + header.size);
  const cluster: ClusterInfo = {
    start,
    end: header.dataStart,
    sizeFieldStart: header.sizeFieldStart,
    sizeFieldLength: header.sizeFieldLength,
    headerLength: header.dataStart - start,
    timecode: 0,
    keyFrames: new Map()
  };
  let position = header.dataStart;

  while (position < limit) {
    const child = readHeaderOrNull(bytes, position);

    if (!child || (header.size === null && !CLUSTER_CHILD_IDS.has(child.id))) {
      break;
    }

    if (child.size === null) {
      return null;
    }

    const childEnd = child.dataStart + child.size;

    if (childEnd > limit) {
      // The recording stopped mid-element: keep the complete part of the cluster.
      break;
    }

    if (child.id === ID.timecode) {
      cluster.timecode = readUnsigned(bytes, child.dataStart, childEnd);
    } else if (child.id === ID.simpleBlock) {
      const block = readBlockHeader(bytes, child.dataStart, childEnd);
      recordBlock(parsed, cluster, block, block.keyFrame, 0);
    } else if (child.id === ID.blockGroup) {
      readBlockGroup(
        bytes,
        { start: position, end: childEnd, dataStart: child.dataStart },
        parsed,
        cluster
      );
    }

    position = childEnd;
    cluster.end = childEnd;
  }

  return cluster.end > header.dataStart ? cluster : null;
}

type BlockHeader = { track: number; relativeTime: number; keyFrame: boolean };

function readBlockGroup(
  bytes: Uint8Array,
  range: ByteRange,
  parsed: ParsedWebm,
  cluster: ClusterInfo
): void {
  let block: BlockHeader | null = null;
  let duration = 0;
  let hasReference = false;

  for (const child of readChildren(bytes, range)) {
    if (child.id === ID.block) {
      block = readBlockHeader(bytes, child.dataStart, child.end);
    } else if (child.id === ID.blockDuration) {
      duration = readUnsigned(bytes, child.dataStart, child.end);
    } else if (child.id === ID.referenceBlock) {
      hasReference = true;
    }
  }

  if (block) {
    recordBlock(parsed, cluster, block, !hasReference, duration);
  }
}

function recordBlock(
  parsed: ParsedWebm,
  cluster: ClusterInfo,
  block: BlockHeader,
  keyFrame: boolean,
  duration: number
): void {
  const time = cluster.timecode + block.relativeTime;
  const times = parsed.blockTimes.get(block.track) ?? [];
  times.push(time);
  parsed.blockTimes.set(block.track, times);
  parsed.maxBlockEnd = Math.max(parsed.maxBlockEnd, time + duration);

  if (keyFrame && !cluster.keyFrames.has(block.track)) {
    cluster.keyFrames.set(block.track, time);
  }
}

function readBlockHeader(bytes: Uint8Array, start: number, end: number): BlockHeader {
  const track = readVint(bytes, start, false);
  const timeOffset = start + track.length;

  if (track.value === null || timeOffset + 3 > end) {
    throw new Error("Invalid block header");
  }

  const raw = ((bytes[timeOffset] ?? 0) << 8) | (bytes[timeOffset + 1] ?? 0);
  const flags = bytes[timeOffset + 2] ?? 0;

  return {
    track: track.value,
    relativeTime: raw >= 0x8000 ? raw - 0x10000 : raw,
    keyFrame: (flags & 0x80) !== 0
  };
}

function readTimecodeScale(bytes: Uint8Array, info: ByteRange): number {
  for (const child of readChildren(bytes, info)) {
    if (child.id === ID.timecodeScale) {
      const scale = readUnsigned(bytes, child.dataStart, child.end);
      return scale > 0 ? scale : DEFAULT_TIMECODE_SCALE_NS;
    }
  }

  return DEFAULT_TIMECODE_SCALE_NS;
}

function readVideoTrack(bytes: Uint8Array, tracks: ByteRange): number | null {
  for (const entry of readChildren(bytes, tracks)) {
    if (entry.id !== ID.trackEntry) {
      continue;
    }

    let number: number | null = null;
    let type: number | null = null;

    for (const child of readChildren(bytes, entry)) {
      if (child.id === ID.trackNumber) {
        number = readUnsigned(bytes, child.dataStart, child.end);
      } else if (child.id === ID.trackType) {
        type = readUnsigned(bytes, child.dataStart, child.end);
      }
    }

    if (number !== null && type === TRACK_TYPE_VIDEO) {
      return number;
    }
  }

  return null;
}

/** The children of a known-size element; a child that overruns its parent is invalid. */
function* readChildren(
  bytes: Uint8Array,
  parent: ByteRange
): Generator<ByteRange & { id: number }> {
  let position = parent.dataStart;

  while (position < parent.end) {
    const header = readElementHeader(bytes, position);

    if (header.size === null || header.dataStart + header.size > parent.end) {
      throw new Error("Invalid child element");
    }

    const end = header.dataStart + header.size;
    yield { id: header.id, start: position, end, dataStart: header.dataStart };
    position = end;
  }
}

function readElementHeader(bytes: Uint8Array, position: number): ElementHeader {
  const id = readVint(bytes, position, true);
  const size = readVint(bytes, position + id.length, false);

  return {
    id: id.value ?? 0,
    size: size.value,
    dataStart: position + id.length + size.length,
    sizeFieldStart: position + id.length,
    sizeFieldLength: size.length
  };
}

/**
 * Reads an EBML variable-length integer. Ids keep their length marker; sizes drop it, and an
 * all-ones size means "unknown" (`value: null`).
 */
function readVint(
  bytes: Uint8Array,
  position: number,
  keepMarker: boolean
): { value: number | null; length: number } {
  const first = bytes[position];

  if (first === undefined) {
    throw new TruncatedError("The bytes end inside an element header");
  }

  if (first === 0) {
    throw new Error("Invalid EBML variable-length integer");
  }

  const length = Math.clz32(first) - 23;

  if (position + length > bytes.length) {
    throw new TruncatedError("The bytes end inside an element header");
  }

  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;

  for (let index = 1; index < length; index += 1) {
    const byte = bytes[position + index] ?? 0;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }

  if (!keepMarker && allOnes) {
    return { value: null, length };
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error("EBML integer out of range");
  }

  return { value, length };
}

function readUnsigned(bytes: Uint8Array, start: number, end: number): number {
  let value = 0;

  for (let index = start; index < end; index += 1) {
    value = value * 256 + (bytes[index] ?? 0);
  }

  return value;
}

/** Duration in timecode ticks: the last block of each track plus that track's usual frame gap. */
function computeDurationTicks(parsed: ParsedWebm): number {
  const maxGapTicks = (MAX_FRAME_GAP_MS * 1_000_000) / parsed.timecodeScale;
  let duration = parsed.maxBlockEnd;

  for (const times of parsed.blockTimes.values()) {
    const sorted = [...times].sort((left, right) => left - right);
    const gaps: number[] = [];

    for (let index = 1; index < sorted.length; index += 1) {
      const gap = (sorted[index] ?? 0) - (sorted[index - 1] ?? 0);

      if (gap > 0 && gap <= maxGapTicks) {
        gaps.push(gap);
      }
    }

    gaps.sort((left, right) => left - right);
    const typicalGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
    duration = Math.max(duration, (sorted[sorted.length - 1] ?? 0) + typicalGap);
  }

  return duration;
}

type CueEntry = { time: number; cluster: ClusterInfo };

function writeSeekableWebm(bytes: Uint8Array, parsed: ParsedWebm): WebmSeekableResult {
  const durationTicks = computeDurationTicks(parsed);
  const info = buildInfo(bytes, parsed.info as ByteRange, durationTicks);
  const tracksRange = parsed.tracks as ByteRange;
  const tracks = bytes.subarray(tracksRange.start, tracksRange.end);
  const others = parsed.others.map((range) => bytes.subarray(range.start, range.end));
  const firstTrack = parsed.blockTimes.keys().next().value ?? 1;
  const cueTrack =
    parsed.videoTrack !== null && parsed.blockTimes.has(parsed.videoTrack)
      ? parsed.videoTrack
      : firstTrack;
  const cues: CueEntry[] = parsed.clusters.flatMap((cluster) => {
    const time = cluster.keyFrames.get(cueTrack);
    return time === undefined ? [] : [{ time: Math.max(0, time), cluster }];
  });
  // Positions are 8-byte fields, so every length below is known before any position is.
  const cuesDataLength = cues.reduce(
    (total, cue) => total + elementLength(ID.cuePoint, cuePointDataLength(cue.time, cueTrack)),
    0
  );
  const cuesLength = cues.length > 0 ? elementLength(ID.cues, cuesDataLength) : 0;
  const seekIds = cues.length > 0 ? [ID.info, ID.tracks, ID.cues] : [ID.info, ID.tracks];
  const seekHeadDataLength = seekIds.length * SEEK_ENTRY_LENGTH;
  const infoPosition = elementLength(ID.seekHead, seekHeadDataLength);
  const tracksPosition = infoPosition + info.length;
  const cuesPosition =
    tracksPosition + tracks.length + others.reduce((total, part) => total + part.length, 0);
  const seekPositions: Record<number, number> = {
    [ID.info]: infoPosition,
    [ID.tracks]: tracksPosition,
    [ID.cues]: cuesPosition
  };
  const clusterPositions = new Map<ClusterInfo, number>();
  let segmentDataLength = cuesPosition + cuesLength;

  for (const cluster of parsed.clusters) {
    clusterPositions.set(cluster, segmentDataLength);
    segmentDataLength += cluster.end - cluster.start;
  }

  const writer = new ByteWriter(
    parsed.ebmlHeader.length + elementLength(ID.segment, segmentDataLength)
  );
  writer.bytes(parsed.ebmlHeader);
  writer.header(ID.segment, segmentDataLength);
  writer.header(ID.seekHead, seekHeadDataLength);
  seekIds.forEach((id) => writeSeekEntry(writer, id, seekPositions[id] ?? 0));
  writer.bytes(info);
  writer.bytes(tracks);
  others.forEach((part) => writer.bytes(part));

  if (cues.length > 0) {
    writer.header(ID.cues, cuesDataLength);
    cues.forEach((cue) =>
      writeCuePoint(writer, cue.time, cueTrack, clusterPositions.get(cue.cluster) ?? 0)
    );
  }

  for (const cluster of parsed.clusters) {
    const clusterStart = writer.offset;
    writer.bytes(bytes.subarray(cluster.start, cluster.end));

    // The cluster's real size goes in place when the field is 8 bytes long (nothing moves).
    if (cluster.sizeFieldLength === SIZE_FIELD_LENGTH) {
      writer.sizeAt(
        clusterStart + (cluster.sizeFieldStart - cluster.start),
        cluster.end - cluster.start - cluster.headerLength
      );
    }
  }

  return {
    bytes: writer.result(),
    durationMs: Math.round((durationTicks * parsed.timecodeScale) / 1_000_000),
    cueCount: cues.length
  };
}

/** Info with its original children (minus Duration and padding) and the computed Duration. */
function buildInfo(bytes: Uint8Array, info: ByteRange, durationTicks: number): Uint8Array {
  const kept: Uint8Array[] = [];

  for (const child of readChildren(bytes, info)) {
    if (child.id !== ID.duration && child.id !== ID.void && child.id !== ID.crc32) {
      kept.push(bytes.subarray(child.start, child.end));
    }
  }

  const dataLength =
    kept.reduce((total, part) => total + part.length, 0) + elementLength(ID.duration, 8);
  const writer = new ByteWriter(elementLength(ID.info, dataLength));
  writer.header(ID.info, dataLength);
  kept.forEach((part) => writer.bytes(part));
  writer.header(ID.duration, 8);
  writer.float64(durationTicks);

  return writer.result();
}

function writeSeekEntry(writer: ByteWriter, id: number, position: number): void {
  writer.header(ID.seek, SEEK_ENTRY_DATA_LENGTH);
  writer.header(ID.seekId, idLength(id));
  writer.unsigned(id, idLength(id));
  writer.header(ID.seekPosition, 8);
  writer.unsigned(position, 8);
}

function cuePointDataLength(time: number, track: number): number {
  return (
    elementLength(ID.cueTime, unsignedLength(time)) +
    elementLength(ID.cueTrackPositions, cueTrackPositionsDataLength(track))
  );
}

function cueTrackPositionsDataLength(track: number): number {
  return (
    elementLength(ID.cueTrack, unsignedLength(track)) + elementLength(ID.cueClusterPosition, 8)
  );
}

function writeCuePoint(writer: ByteWriter, time: number, track: number, position: number): void {
  writer.header(ID.cuePoint, cuePointDataLength(time, track));
  writer.header(ID.cueTime, unsignedLength(time));
  writer.unsigned(time, unsignedLength(time));
  writer.header(ID.cueTrackPositions, cueTrackPositionsDataLength(track));
  writer.header(ID.cueTrack, unsignedLength(track));
  writer.unsigned(track, unsignedLength(track));
  writer.header(ID.cueClusterPosition, 8);
  writer.unsigned(position, 8);
}

function unsignedLength(value: number): number {
  let length = 1;

  while (length < 8 && value >= 2 ** (8 * length)) {
    length += 1;
  }

  return length;
}

const idLength = unsignedLength;

function elementLength(id: number, dataLength: number): number {
  return idLength(id) + SIZE_FIELD_LENGTH + dataLength;
}

/** Every Seek entry has the same length: 4-byte top-level ids and 8-byte positions. */
const SEEK_ENTRY_DATA_LENGTH =
  elementLength(ID.seekId, idLength(ID.info)) + elementLength(ID.seekPosition, 8);
const SEEK_ENTRY_LENGTH = elementLength(ID.seek, SEEK_ENTRY_DATA_LENGTH);

class ByteWriter {
  private readonly buffer: Uint8Array;

  private readonly view: DataView;

  public offset = 0;

  public constructor(length: number) {
    this.buffer = new Uint8Array(length);
    this.view = new DataView(this.buffer.buffer);
  }

  public bytes(part: Uint8Array): void {
    this.buffer.set(part, this.offset);
    this.offset += part.length;
  }

  /** An element id and an 8-byte size field. */
  public header(id: number, dataLength: number): void {
    this.unsigned(id, idLength(id));
    this.sizeAt(this.offset, dataLength);
    this.offset += SIZE_FIELD_LENGTH;
  }

  /** Writes an 8-byte EBML size (`0x01` marker + 7 bytes) at `position`. */
  public sizeAt(position: number, value: number): void {
    this.buffer[position] = 0x01;
    writeBigEndian(this.buffer, position + 1, value, SIZE_FIELD_LENGTH - 1);
  }

  public unsigned(value: number, length: number): void {
    writeBigEndian(this.buffer, this.offset, value, length);
    this.offset += length;
  }

  public float64(value: number): void {
    this.view.setFloat64(this.offset, value);
    this.offset += 8;
  }

  public result(): Uint8Array {
    return this.buffer;
  }
}

function writeBigEndian(target: Uint8Array, position: number, value: number, length: number): void {
  let remaining = value;

  for (let index = length - 1; index >= 0; index -= 1) {
    target[position + index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
}
