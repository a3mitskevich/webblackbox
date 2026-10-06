import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeWebmSeekable } from "./webm-seekable.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "mediarecorder-vp9"
);

/** Five 1 s timeslice chunks of a 4.5 s Chrome MediaRecorder recording (32×18 VP9, key frame every 1 s). */
function readRecorderChunks(): Uint8Array[] {
  return [0, 1, 2, 3, 4].map(
    (index) => new Uint8Array(readFileSync(join(FIXTURE_DIR, `chunk-${index}.webm`)))
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

// --- A minimal EBML writer for synthetic streams -------------------------------------------

const UNKNOWN = -1;

function idBytes(id: number): number[] {
  const out: number[] = [];
  let value = id;

  while (value > 0) {
    out.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }

  return out;
}

function sizeBytes(size: number): number[] {
  if (size === UNKNOWN) {
    return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  }

  if (size < 0x7f) {
    return [0x80 | size];
  }

  return [0x40 | (size >> 8), size & 0xff];
}

function el(id: number, body: readonly number[]): number[] {
  return [...idBytes(id), ...sizeBytes(body.length), ...body];
}

function uint(id: number, value: number, length = 1): number[] {
  const body: number[] = [];

  for (let index = length - 1; index >= 0; index -= 1) {
    body.push(Math.floor(value / 256 ** index) & 0xff);
  }

  return el(id, body);
}

function simpleBlock(track: number, relativeTime: number, keyFrame: boolean): number[] {
  return el(0xa3, [
    0x80 | track,
    (relativeTime >> 8) & 0xff,
    relativeTime & 0xff,
    keyFrame ? 0x80 : 0,
    1,
    2,
    3
  ]);
}

const EBML_HEADER = el(0x1a45dfa3, el(0x4282, [...new TextEncoder().encode("webm")]));
const INFO = el(0x1549a966, [...uint(0x2ad7b1, 1_000_000, 3), ...el(0x4d80, [0x41])]);

function tracks(entries: Array<{ number: number; type: number }>): number[] {
  return el(
    0x1654ae6b,
    entries.flatMap((entry) => el(0xae, [...uint(0xd7, entry.number), ...uint(0x83, entry.type)]))
  );
}

function liveCluster(timecode: number, blocks: number[][]): number[] {
  return [
    ...idBytes(0x1f43b675),
    ...sizeBytes(UNKNOWN),
    ...uint(0xe7, timecode, 2),
    ...blocks.flat()
  ];
}

function liveSegment(children: number[][]): Uint8Array {
  return new Uint8Array([
    ...EBML_HEADER,
    ...idBytes(0x18538067),
    ...sizeBytes(UNKNOWN),
    ...children.flat()
  ]);
}

// --- A minimal EBML reader for the assertions ----------------------------------------------

type Element = { id: number; start: number; dataStart: number; end: number; unknown: boolean };

function readVint(bytes: Uint8Array, position: number, keepMarker: boolean) {
  const first = bytes[position] ?? 0;
  const length = Math.clz32(first) - 23;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;

  for (let index = 1; index < length; index += 1) {
    const byte = bytes[position + index] ?? 0;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }

  return { value, length, unknown: !keepMarker && allOnes };
}

function children(bytes: Uint8Array, start: number, end: number): Element[] {
  const out: Element[] = [];
  let position = start;

  while (position < end) {
    const id = readVint(bytes, position, true);
    const size = readVint(bytes, position + id.length, false);
    const dataStart = position + id.length + size.length;
    const elementEnd = size.unknown ? end : dataStart + size.value;
    out.push({ id: id.value, start: position, dataStart, end: elementEnd, unknown: size.unknown });
    position = elementEnd;
  }

  return out;
}

function readUint(bytes: Uint8Array, element: Element): number {
  let value = 0;

  for (let index = element.dataStart; index < element.end; index += 1) {
    value = value * 256 + (bytes[index] ?? 0);
  }

  return value;
}

function only(elements: Element[], id: number): Element {
  const found = elements.filter((element) => element.id === id);
  expect(found).toHaveLength(1);
  return found[0] as Element;
}

function pair(bytes: Uint8Array, parent: Element): [Element, Element] {
  return children(bytes, parent.dataStart, parent.end) as [Element, Element];
}

/** A fixed file: every top-level size is known, so the plain reader walks it. */
function inspect(bytes: Uint8Array) {
  const [ebml, segment] = children(bytes, 0, bytes.length) as [Element, Element];
  const top = children(bytes, segment.dataStart, segment.end);
  const info = only(top, 0x1549a966);
  const duration = only(children(bytes, info.dataStart, info.end), 0x4489);
  const seekHead = only(top, 0x114d9b74);
  const seeks = children(bytes, seekHead.dataStart, seekHead.end).map((seek) => {
    const [id, position] = pair(bytes, seek);
    return { id: readUint(bytes, id), position: readUint(bytes, position) };
  });
  const cuesElement = top.find((element) => element.id === 0x1c53bb6b);
  const cues = (cuesElement ? children(bytes, cuesElement.dataStart, cuesElement.end) : []).map(
    (point) => {
      const [time, positions] = pair(bytes, point);
      const [track, cluster] = pair(bytes, positions);
      return {
        time: readUint(bytes, time),
        track: readUint(bytes, track),
        cluster: readUint(bytes, cluster)
      };
    }
  );

  return {
    ebml,
    segment,
    top,
    durationTicks: new DataView(bytes.buffer, bytes.byteOffset).getFloat64(duration.dataStart),
    seeks,
    cues,
    clusters: top.filter((element) => element.id === 0x1f43b675),
    /** Offset of an element relative to the Segment data (what SeekHead and Cues store). */
    position: (element: Element) => element.start - segment.dataStart
  };
}

/** The bytes of every cluster's children (timecodes and frames), which must survive unchanged. */
function clusterPayloads(bytes: Uint8Array): number[][] {
  const [, segment] = children(bytes, 0, bytes.length) as [Element, Element];
  const payloads: number[][] = [];
  let position = segment.dataStart;

  while (position < segment.end) {
    const id = readVint(bytes, position, true);
    const size = readVint(bytes, position + id.length, false);
    const dataStart = position + id.length + size.length;

    if (id.value !== 0x1f43b675) {
      position = dataStart + size.value;
      continue;
    }

    const limit = size.unknown ? segment.end : dataStart + size.value;
    let end = dataStart;

    while (end < limit) {
      const childId = readVint(bytes, end, true);

      if (![0xe7, 0xa3, 0xa0, 0xec].includes(childId.value)) {
        break;
      }

      const childSize = readVint(bytes, end + childId.length, false);
      end += childId.length + childSize.length + childSize.value;
    }

    payloads.push([...bytes.subarray(dataStart, end)]);
    position = end;
  }

  return payloads;
}

describe("makeWebmSeekable", () => {
  it("gives a Chrome MediaRecorder recording a Duration, a SeekHead and Cues, frames unchanged", () => {
    const raw = concat(readRecorderChunks());
    const result = makeWebmSeekable(raw);

    expect(result).not.toBeNull();
    const fixed = result?.bytes ?? new Uint8Array();
    const view = inspect(fixed);

    // 4.5 s recorded at 10 fps.
    expect(result?.durationMs).toBeGreaterThan(4_000);
    expect(result?.durationMs).toBeLessThan(5_000);
    expect(view.durationTicks).toBe(result?.durationMs);
    expect(view.segment.unknown).toBe(false);
    expect(view.segment.end).toBe(fixed.length);
    expect(view.clusters).toHaveLength(5);
    expect(view.clusters.every((cluster) => !cluster.unknown)).toBe(true);
    expect(result?.cueCount).toBe(5);
    expect(view.cues.map((cue) => cue.cluster)).toEqual(view.clusters.map(view.position));
    expect(view.cues.every((cue) => cue.track === 1)).toBe(true);
    expect(view.cues[0]?.time).toBe(0);
    expect(
      view.seeks.map(
        (seek) => view.top.find((element) => view.position(element) === seek.position)?.id
      )
    ).toEqual([0x1549a966, 0x1654ae6b, 0x1c53bb6b]);
    expect(view.seeks.map((seek) => seek.id)).toEqual([0x1549a966, 0x1654ae6b, 0x1c53bb6b]);
    expect(clusterPayloads(fixed)).toEqual(clusterPayloads(raw));
  });

  it("is idempotent: a fixed file comes out the same", () => {
    const fixed = makeWebmSeekable(concat(readRecorderChunks()))?.bytes;

    expect(fixed).toBeDefined();
    expect(makeWebmSeekable(fixed as Uint8Array)?.bytes).toEqual(fixed);
  });

  it("keeps the complete part of a recording cut inside a frame", () => {
    const raw = concat(readRecorderChunks());
    const result = makeWebmSeekable(raw.subarray(0, raw.length - 40));

    expect(result).not.toBeNull();
    expect(result?.durationMs).toBeLessThan(makeWebmSeekable(raw)?.durationMs ?? 0);
    expect(inspect(result?.bytes ?? new Uint8Array()).segment.end).toBe(result?.bytes.length);
  });

  it("measures the duration from the last frame plus the usual frame gap", () => {
    const raw = liveSegment([
      INFO,
      tracks([{ number: 1, type: 1 }]),
      liveCluster(0, [
        simpleBlock(1, 0, true),
        simpleBlock(1, 40, false),
        simpleBlock(1, 80, false)
      ]),
      liveCluster(1_000, [simpleBlock(1, 0, true), simpleBlock(1, 40, false)])
    ]);
    const result = makeWebmSeekable(raw);
    const view = inspect(result?.bytes ?? new Uint8Array());

    // Frames at 0, 40, 80 ms, a pause, then 1000 and 1040 ms: one more 40 ms gap ends the media.
    expect(result?.durationMs).toBe(1_080);
    expect(view.cues.map((cue) => cue.time)).toEqual([0, 1_000]);
  });

  it("cues the video track's key frames and skips clusters without one", () => {
    const raw = liveSegment([
      INFO,
      tracks([
        { number: 1, type: 2 },
        { number: 2, type: 1 }
      ]),
      liveCluster(0, [simpleBlock(1, 0, true), simpleBlock(2, 5, true)]),
      liveCluster(500, [simpleBlock(1, 0, true), simpleBlock(2, 10, false)]),
      liveCluster(900, [simpleBlock(2, 20, true)])
    ]);
    const view = inspect(makeWebmSeekable(raw)?.bytes ?? new Uint8Array());
    const [first, , third] = view.clusters as [Element, Element, Element];

    expect(view.cues).toEqual([
      { time: 5, track: 2, cluster: view.position(first) },
      { time: 920, track: 2, cluster: view.position(third) }
    ]);
  });

  it("reads BlockGroups: BlockDuration extends the media, a ReferenceBlock is not a key frame", () => {
    const blockGroup = (duration: number, reference: boolean) =>
      el(0xa0, [
        ...el(0xa1, [0x81, 0, 0, 0, 9]),
        ...uint(0x9b, duration),
        ...(reference ? el(0xfb, [0xf6]) : [])
      ]);
    const raw = liveSegment([
      INFO,
      tracks([{ number: 1, type: 2 }]),
      liveCluster(0, [blockGroup(20, false)]),
      liveCluster(100, [blockGroup(250, true)])
    ]);
    const result = makeWebmSeekable(raw);

    expect(result?.durationMs).toBe(350);
    expect(result?.cueCount).toBe(1);
  });

  it("rebuilds the SeekHead, Cues and Duration and keeps other top-level elements", () => {
    const staleInfo = el(0x1549a966, [
      ...uint(0x2ad7b1, 1_000_000, 3),
      ...el(0x4489, [0x40, 0x59, 0, 0, 0, 0, 0, 0])
    ]);
    const raw = liveSegment([
      el(0x114d9b74, el(0x4dbb, [])),
      staleInfo,
      tracks([{ number: 1, type: 1 }]),
      el(0x1254c367, el(0x7373, [])),
      el(0x1c53bb6b, el(0xbb, [])),
      el(0xec, [0, 0]),
      liveCluster(0, [simpleBlock(1, 0, true), simpleBlock(1, 30, false)])
    ]);
    const view = inspect(makeWebmSeekable(raw)?.bytes ?? new Uint8Array());

    expect(view.top.map((element) => element.id)).toEqual([
      0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1254c367, 0x1c53bb6b, 0x1f43b675
    ]);
    expect(view.durationTicks).toBe(60);
  });

  it("leaves a cluster's short size field alone", () => {
    const body = [...uint(0xe7, 0, 2), ...simpleBlock(1, 0, true), ...simpleBlock(1, 50, false)];
    const raw = liveSegment([INFO, tracks([{ number: 1, type: 1 }]), el(0x1f43b675, body)]);
    const result = makeWebmSeekable(raw);
    const [cluster] = inspect(result?.bytes ?? new Uint8Array()).clusters as [Element];

    expect(cluster.dataStart - cluster.start).toBe(5);
    expect(result?.durationMs).toBe(100);
  });

  it("skips an empty cluster without dropping the clusters after it", () => {
    const raw = liveSegment([
      INFO,
      tracks([{ number: 1, type: 1 }]),
      liveCluster(0, [simpleBlock(1, 0, true), simpleBlock(1, 40, false)]),
      [...idBytes(0x1f43b675), ...sizeBytes(UNKNOWN)],
      liveCluster(1_000, [simpleBlock(1, 0, true), simpleBlock(1, 40, false)])
    ]);
    const result = makeWebmSeekable(raw);
    const view = inspect(result?.bytes ?? new Uint8Array());

    expect(result?.durationMs).toBe(1_080);
    expect(view.clusters).toHaveLength(2);
    expect(view.cues.map((cue) => cue.time)).toEqual([0, 1_000]);
  });

  it("keeps the bytes as they are when a cluster cannot be read in the middle of the file", () => {
    const videoTracks = tracks([{ number: 1, type: 1 }]);
    const nextCluster = liveCluster(1_000, [simpleBlock(1, 0, true)]);

    // A child of unknown size inside a cluster.
    expect(
      makeWebmSeekable(
        liveSegment([
          INFO,
          videoTracks,
          liveCluster(0, [simpleBlock(1, 0, true), [...idBytes(0xa3), ...sizeBytes(UNKNOWN)]]),
          nextCluster
        ])
      )
    ).toBeNull();
    // A frame that overruns its known-size cluster, with more media after it.
    const frames = [...uint(0xe7, 0, 2), ...simpleBlock(1, 0, true), ...simpleBlock(1, 40, false)];
    expect(
      makeWebmSeekable(
        liveSegment([
          INFO,
          videoTracks,
          [...idBytes(0x1f43b675), ...sizeBytes(frames.length - 3), ...frames],
          nextCluster
        ])
      )
    ).toBeNull();
  });

  it("returns null for bytes it does not understand", () => {
    const videoTracks = tracks([{ number: 1, type: 1 }]);

    expect(makeWebmSeekable(new Uint8Array())).toBeNull();
    // An MP4 `ftyp` box.
    expect(makeWebmSeekable(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
    // Headers without a single frame.
    expect(makeWebmSeekable(liveSegment([INFO, videoTracks]))).toBeNull();
    // No Tracks.
    expect(
      makeWebmSeekable(liveSegment([INFO, liveCluster(0, [simpleBlock(1, 0, true)])]))
    ).toBeNull();
    // An EBML header without a Segment.
    expect(makeWebmSeekable(new Uint8Array([...EBML_HEADER, ...el(0x1549a966, [])]))).toBeNull();
    // A zero byte where an element id should be.
    expect(
      makeWebmSeekable(
        new Uint8Array([...EBML_HEADER, ...idBytes(0x18538067), ...sizeBytes(UNKNOWN), 0])
      )
    ).toBeNull();
    // A non-cluster element of unknown size.
    expect(
      makeWebmSeekable(
        liveSegment([
          [...idBytes(0x1549a966), ...sizeBytes(UNKNOWN)],
          liveCluster(0, [simpleBlock(1, 0, true)])
        ])
      )
    ).toBeNull();
  });
});
