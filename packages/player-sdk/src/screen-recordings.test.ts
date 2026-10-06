import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import { WebBlackboxPlayer } from "./index.js";
import {
  assembleScreenRecording,
  listScreenRecordings,
  ScreenRecordingIncompleteError
} from "./screen-recordings.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "mediarecorder-vp9"
);
const MIME = "video/webm;codecs=vp9";

let nextId = 0;

function event(type: string, mono: number, data: Record<string, unknown>): WebBlackboxEvent {
  nextId += 1;
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_000 + mono,
    mono,
    type,
    id: `E-${nextId}`,
    data
  } as WebBlackboxEvent;
}

function start(recordingId: string, mono: number): WebBlackboxEvent {
  return event("screen.recording.start", mono, {
    recordingId,
    source: "tab",
    mime: MIME,
    width: 1280,
    height: 720
  });
}

function chunk(recordingId: string, index: number, mono: number, size = 10): WebBlackboxEvent {
  return event("screen.recording.chunk", mono, {
    recordingId,
    chunkId: `${recordingId}-c${index}`,
    index,
    mime: MIME,
    size
  });
}

function end(recordingId: string, mono: number, chunks: string[]): WebBlackboxEvent {
  return event("screen.recording.end", mono, {
    recordingId,
    mime: MIME,
    chunks,
    chunkCount: chunks.length,
    size: chunks.length * 10,
    durationMs: mono - 100,
    reason: "session-stop"
  });
}

describe("listScreenRecordings", () => {
  it("orders chunks by index, not by event order", () => {
    const [segment] = listScreenRecordings([
      start("R1", 100),
      chunk("R1", 2, 400),
      chunk("R1", 0, 200),
      chunk("R1", 1, 300),
      end("R1", 500, ["R1-c0", "R1-c1", "R1-c2"])
    ]);

    expect(segment).toMatchObject({
      recordingId: "R1",
      part: 1,
      source: "tab",
      mime: MIME,
      startMono: 100,
      endMono: 500,
      durationMs: 400,
      size: 30,
      width: 1280,
      height: 720,
      chunkCount: 3,
      missingChunks: [],
      ended: true,
      endReason: "session-stop"
    });
    expect(segment?.chunks.map((entry) => entry.chunkId)).toEqual(["R1-c0", "R1-c1", "R1-c2"]);
  });

  it("lists every segment of a restarted recording in start order", () => {
    const segments = listScreenRecordings([
      chunk("B", 0, 1_200),
      start("B", 1_100),
      start("A", 100),
      chunk("A", 0, 200),
      end("A", 300, ["A-c0"]),
      end("B", 1_300, ["B-c0"]),
      // A recording that failed to start has no chunks: it is not a video.
      start("C", 2_000)
    ]);

    expect(segments.map((segment) => [segment.recordingId, segment.part])).toEqual([
      ["A", 1],
      ["B", 2]
    ]);
  });

  it("reports chunks that no event references", () => {
    const [segment] = listScreenRecordings([
      start("R1", 100),
      chunk("R1", 0, 200),
      chunk("R1", 2, 400),
      chunk("R1", 4, 600),
      // The end lists stored chunks only: index 1 and 3 failed to store.
      end("R1", 700, ["R1-c0", "R1-c2", "R1-c4"])
    ]);

    expect(segment?.chunkCount).toBe(5);
    expect(segment?.missingChunks).toEqual([1, 3]);
    expect(segment?.chunks.map((entry) => entry.index)).toEqual([0, 2, 4]);
  });

  it("takes chunks from a complete end list when their chunk events are gone", () => {
    const [segment] = listScreenRecordings([
      chunk("R1", 2, 400),
      end("R1", 500, ["R1-c0", "R1-c1", "R1-c2"])
    ]);

    expect(segment?.missingChunks).toEqual([]);
    expect(segment?.chunks.map((entry) => entry.chunkId)).toEqual(["R1-c0", "R1-c1", "R1-c2"]);
    // No start event: the first chunk event marks the start.
    expect(segment?.startMono).toBe(400);
  });

  it("dates a recording known only from its end event by its duration", () => {
    const [segment] = listScreenRecordings([end("R1", 500, ["R1-c0"])]);

    expect(segment).toMatchObject({ startMono: 100, endMono: 500, durationMs: 400 });
  });

  it("ignores an end list that disagrees with the chunk events", () => {
    const [segment] = listScreenRecordings([chunk("R1", 1, 300), end("R1", 500, ["X", "Y"])]);

    expect(segment?.chunks.map((entry) => entry.chunkId)).toEqual(["R1-c1"]);
    expect(segment?.missingChunks).toEqual([0]);
  });

  it("keeps a recording without an end event, timed by its chunks", () => {
    const [segment] = listScreenRecordings([chunk("R1", 0, 200), chunk("R1", 1, 900, 5)]);

    expect(segment).toMatchObject({
      startMono: 200,
      endMono: 900,
      durationMs: 700,
      size: 15,
      mime: MIME,
      source: null,
      ended: false,
      missingChunks: []
    });
    expect(segment?.endReason).toBeUndefined();
  });

  it("skips malformed recording events", () => {
    expect(
      listScreenRecordings([
        event("screen.recording.chunk", 1, { chunkId: "x", index: 0 }),
        event("screen.recording.chunk", 2, { recordingId: "R", chunkId: "x", index: -1 }),
        event("screen.recording.chunk", 3, { recordingId: "R", index: 0 }),
        event("screen.recording.end", 4, { recordingId: "R", chunks: "nope" }),
        event("user.click", 5, { recordingId: "R" })
      ])
    ).toEqual([]);
  });
});

describe("assembleScreenRecording", () => {
  const blobs = new Map([
    ["R1-c0", new Uint8Array([1, 2])],
    ["R1-c1", new Uint8Array([3])],
    ["R1-c2", new Uint8Array([4, 5, 6])]
  ]);
  const getBlob = async (chunkId: string) => {
    const bytes = blobs.get(chunkId);
    return bytes ? { bytes } : null;
  };

  it("joins the chunks in index order and keeps bytes it cannot fix as they are", async () => {
    const [segment] = listScreenRecordings([
      start("R1", 100),
      chunk("R1", 1, 300),
      chunk("R1", 0, 200),
      chunk("R1", 2, 400),
      end("R1", 500, ["R1-c0", "R1-c1", "R1-c2"])
    ]);
    const video = await assembleScreenRecording(segment!, getBlob);

    expect([...video.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(video).toMatchObject({
      recordingId: "R1",
      mime: MIME,
      durationMs: 400,
      seekable: false
    });
  });

  it("names every missing chunk: unreferenced and not stored", async () => {
    const [segment] = listScreenRecordings([
      chunk("R1", 0, 200),
      chunk("R1", 2, 400),
      chunk("R1", 3, 450),
      end("R1", 500, ["R1-c0", "R1-c2", "R1-c3"])
    ]);
    const error: unknown = await assembleScreenRecording(segment!, getBlob).catch(
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(ScreenRecordingIncompleteError);
    expect(error).toMatchObject({
      recordingId: "R1",
      chunkCount: 4,
      missing: [
        { index: 1, chunkId: null },
        { index: 3, chunkId: "R1-c3" }
      ],
      message:
        "Screen recording R1 is incomplete: 2 of 4 chunks are missing from the archive (index 1, 3)."
    });
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A plain archive with the fixture's MediaRecorder chunks as blobs. */
async function createVideoArchive(options: { dropBlob?: number } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const chunks = [0, 1, 2, 3, 4].map(
    (index) => new Uint8Array(readFileSync(join(FIXTURE_DIR, `chunk-${index}.webm`)))
  );
  const hashes = chunks.map(sha256);
  const recordingId = "VR-1";
  const events: WebBlackboxEvent[] = [
    event("meta.session.start", 1, {}),
    event("screen.recording.start", 10, { recordingId, source: "tab", mime: MIME }),
    // Stored out of index order on purpose.
    ...[3, 0, 4, 1, 2].map((index, position) =>
      event("screen.recording.chunk", 1_000 + position * 1_000, {
        recordingId,
        chunkId: hashes[index],
        index,
        mime: MIME,
        size: chunks[index]?.length
      })
    ),
    event("screen.recording.end", 6_000, {
      recordingId,
      mime: MIME,
      chunks: hashes,
      chunkCount: 5,
      size: chunks.reduce((total, bytes) => total + bytes.length, 0),
      durationMs: 4_590
    })
  ];
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://example.com" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: { eventCount: events.length, chunkCount: 1, blobCount: 5, durationMs: 6_000 }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", "[]");
  zip.file("index/req.json", "[]");
  zip.file("index/inv.json", "[]");
  zip.file("events/chunk-000001.ndjson", events.map((entry) => JSON.stringify(entry)).join("\n"));
  chunks.forEach((bytes, index) => {
    if (index !== options.dropBlob) {
      zip.file(`blobs/sha256-${hashes[index]}.webm`, bytes);
    }
  });

  const files: Record<string, string> = {};

  for (const path of Object.keys(zip.files).sort()) {
    const file = zip.file(path);

    if (file) {
      files[path] = sha256(await file.async("uint8array"));
    }
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: files["manifest.json"], files })
  );

  return zip.generateAsync({ type: "uint8array" });
}

describe("WebBlackboxPlayer screen recordings", () => {
  it("lists the tab video and returns it as a seekable WebM", async () => {
    const player = await WebBlackboxPlayer.open(await createVideoArchive());
    const [segment] = player.getScreenRecordings();

    expect(segment).toMatchObject({ recordingId: "VR-1", chunkCount: 5, missingChunks: [] });

    const raw = await player.getScreenRecordingBlob("VR-1", { raw: true });
    const video = await player.getScreenRecordingBlob("VR-1");

    expect(raw.seekable).toBe(false);
    expect(raw.durationMs).toBe(4_590);
    expect(raw.bytes.length).toBe(segment?.size);
    expect(video.seekable).toBe(true);
    expect(video.mime).toBe(MIME);
    expect(video.durationMs).toBeGreaterThan(4_000);
    expect(video.durationMs).toBeLessThan(5_000);
    // The fixed file adds a SeekHead, a Duration and Cues around the same frames.
    expect(video.bytes.length).toBeGreaterThan(raw.bytes.length);
  });

  it("says which chunk is missing from the archive", async () => {
    const player = await WebBlackboxPlayer.open(await createVideoArchive({ dropBlob: 2 }));

    await expect(player.getScreenRecordingBlob("VR-1")).rejects.toMatchObject({
      name: "ScreenRecordingIncompleteError",
      missing: [{ index: 2, chunkId: expect.any(String) }]
    });
    await expect(player.getScreenRecordingBlob("nope")).rejects.toThrow(
      "Unknown screen recording: nope"
    );
  });

  it("returns copies, so a caller cannot change the cached list", async () => {
    const player = await WebBlackboxPlayer.open(await createVideoArchive());
    const [first] = player.getScreenRecordings();
    first!.part = 99;

    expect(player.getScreenRecordings()[0]?.part).toBe(1);
  });
});
