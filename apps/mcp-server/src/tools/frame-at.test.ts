import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { beforeAll, describe, expect, it } from "vitest";

import { renderFrameAt } from "./frame-at.js";
import {
  createFfmpegDecoder,
  createFfmpegDecoderProvider,
  FFMPEG_ENV,
  type FrameDecoder,
  type FrameDecoderProvider
} from "./frame-decoder.js";
import { buildArchiveBytes, fixtureBlob, fixtureEvent, type FixtureBlob } from "./test-archive.js";
import { checkoutScenario, SCREENSHOT_AFTER } from "./test-scenario.js";

const NO_DECODER: FrameDecoderProvider = async () => ({ decoder: null, note: "no decoder" });
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const HAS_FFMPEG = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

type DecoderCall = { kind: "video" | "scale"; offsetMs?: number; maxWidth: number };

function fakeDecoder(calls: DecoderCall[]): FrameDecoderProvider {
  const decoder: FrameDecoder = {
    name: "fake",
    extractVideoFrame: async (_video, _mime, offsetMs, maxWidth) => {
      calls.push({ kind: "video", offsetMs, maxWidth });
      return { bytes: FAKE_JPEG, mimeType: "image/jpeg" };
    },
    scaleImage: async (_image, _mime, maxWidth) => {
      calls.push({ kind: "scale", maxWidth });
      return { bytes: FAKE_JPEG, mimeType: "image/jpeg" };
    }
  };
  return async () => ({ decoder, note: "fake" });
}

function recordingEvents(video: FixtureBlob): WebBlackboxEvent[] {
  const recording = { recordingId: "V-1", mime: "video/webm" };
  return [
    fixtureEvent("V-start", "screen.recording.start", 1_000, { ...recording, source: "tab" }),
    fixtureEvent("V-chunk", "screen.recording.chunk", 2_900, {
      ...recording,
      chunkId: video.hash,
      index: 0,
      size: video.bytes.byteLength
    }),
    fixtureEvent("V-end", "screen.recording.end", 3_000, {
      ...recording,
      chunks: [video.hash],
      chunkCount: 1,
      durationMs: 2_000
    })
  ];
}

async function singleScreenshotPlayer(blob: FixtureBlob): Promise<WebBlackboxPlayer> {
  return WebBlackboxPlayer.open(
    await buildArchiveBytes(
      [fixtureEvent("S-1", "screen.screenshot", 10, { shotId: blob.hash, format: "webp" })],
      [blob]
    )
  );
}

let checkout: WebBlackboxPlayer;

beforeAll(async () => {
  const { events, blobs } = checkoutScenario();
  checkout = await WebBlackboxPlayer.open(await buildArchiveBytes(events, blobs));
});

describe("frame_at", () => {
  it("returns the nearest screenshot as an image with its time and distance", async () => {
    const result = await renderFrameAt(
      checkout,
      "a",
      { actionId: "A-1", offsetMs: 500 },
      NO_DECODER
    );

    expect(result.data.anchor).toMatchObject({ mono: 1_500, by: "actionId", eventId: "E-5" });
    expect(result.data.frame).toMatchObject({
      source: "screenshot",
      eventId: "E-14",
      mono: 1_300,
      distanceMs: -200,
      reason: "action",
      pointer: { x: 50, y: 35 }
    });
    expect(result.data.image).toMatchObject({
      included: true,
      mimeType: "image/webp",
      bytes: SCREENSHOT_AFTER.bytes.byteLength
    });
    expect(result.images).toHaveLength(1);
    expect(Array.from(result.images?.[0]?.bytes ?? [])).toEqual(Array.from(SCREENSHOT_AFTER.bytes));
    expect(result.images?.[0]?.caption).toContain("-200 ms from the requested 1500");
  });

  it("gives the neighbours so the agent can step through screenshots", async () => {
    const { data } = await renderFrameAt(checkout, "a", { mono: 700 }, NO_DECODER);

    expect(data.frame).toMatchObject({ eventId: "E-3" });
    expect(data.neighbours).toEqual({
      before: { eventId: "E-3", mono: 100, deltaMs: -600, reason: "navigation" },
      after: { eventId: "E-14", mono: 1_300, deltaMs: 600, reason: "action" }
    });
  });

  it("returns only metadata when includeImage is false", async () => {
    const result = await renderFrameAt(
      checkout,
      "a",
      { eventId: "E-3", includeImage: false },
      NO_DECODER
    );

    expect(result.images).toEqual([]);
    expect(result.data.frame).toMatchObject({ eventId: "E-3", distanceMs: 0 });
    expect(result.data.image).toMatchObject({
      included: false,
      withheldReason: "includeImage=false"
    });
  });

  it("withholds an image over maxBytes when nothing can downscale it", async () => {
    const player = await singleScreenshotPlayer(
      fixtureBlob(new Uint8Array(30_000).fill(7), "webp")
    );
    const result = await renderFrameAt(player, "a", { mono: 10, maxBytes: 20_000 }, NO_DECODER);

    expect(result.images).toEqual([]);
    expect(result.data.image).toMatchObject({ included: false });
    expect((result.data.image as { withheldReason: string }).withheldReason).toMatch(
      /30000 bytes, over maxBytes 20000.*no decoder/
    );
  });

  it("sends a screenshot that fits maxBytes as recorded when maxWidth cannot be applied", async () => {
    const result = await renderFrameAt(checkout, "a", { mono: 100, maxWidth: 320 }, NO_DECODER);

    expect(result.images).toHaveLength(1);
    expect(result.data.image).toMatchObject({
      included: true,
      scaledToWidth: null,
      withheldReason: null
    });
    expect(result.data.notes).toContainEqual(
      expect.stringMatching(/recorded size, not scaled to maxWidth: no decoder/)
    );
  });

  it("falls back when the decoder fails instead of failing the call", async () => {
    const failing: FrameDecoderProvider = async () => ({
      decoder: {
        name: "broken",
        extractVideoFrame: async () => {
          throw new Error("unused");
        },
        scaleImage: async () => {
          throw new Error("corrupt input");
        }
      },
      note: "broken"
    });
    const fitting = await renderFrameAt(checkout, "a", { mono: 100, maxWidth: 320 }, failing);
    const oversized = await renderFrameAt(
      await singleScreenshotPlayer(fixtureBlob(new Uint8Array(30_000).fill(7), "webp")),
      "a",
      { mono: 10, maxBytes: 20_000 },
      failing
    );

    expect(fitting.images).toHaveLength(1);
    expect(fitting.data.notes).toContainEqual(
      expect.stringMatching(/broken failed: corrupt input/)
    );
    expect(oversized.images).toEqual([]);
    expect((oversized.data.image as { withheldReason: string }).withheldReason).toMatch(
      /over maxBytes 20000.*broken failed: corrupt input/
    );
  });

  it("downscales an oversized or width-capped screenshot through the decoder", async () => {
    const calls: DecoderCall[] = [];
    const player = await singleScreenshotPlayer(
      fixtureBlob(new Uint8Array(30_000).fill(7), "webp")
    );
    const oversized = await renderFrameAt(
      player,
      "a",
      { mono: 10, maxBytes: 20_000 },
      fakeDecoder(calls)
    );
    const capped = await renderFrameAt(
      checkout,
      "a",
      { mono: 100, maxWidth: 320 },
      fakeDecoder(calls)
    );

    expect(oversized.data.image).toMatchObject({
      included: true,
      mimeType: "image/jpeg",
      scaledToWidth: 1_280
    });
    expect(capped.data.image).toMatchObject({ included: true, scaledToWidth: 320 });
    expect(calls).toEqual([
      { kind: "scale", maxWidth: 1_280 },
      { kind: "scale", maxWidth: 320 }
    ]);
  });

  it("decodes the tab video frame when no screenshot is close and a decoder exists", async () => {
    const video = fixtureBlob(new Uint8Array([1, 2, 3, 4]), "webm");
    const player = await WebBlackboxPlayer.open(
      await buildArchiveBytes(
        [
          ...recordingEvents(video),
          fixtureEvent("S-1", "screen.screenshot", 1_480, {
            shotId: SCREENSHOT_AFTER.hash,
            format: "webp"
          })
        ],
        [video, SCREENSHOT_AFTER]
      )
    );
    const calls: DecoderCall[] = [];
    const fromVideo = await renderFrameAt(player, "a", { mono: 2_000 }, fakeDecoder(calls));
    const nearShot = await renderFrameAt(player, "a", { mono: 1_500 }, fakeDecoder(calls));
    const withoutDecoder = await renderFrameAt(player, "a", { mono: 2_000 }, NO_DECODER);
    const forcedVideo = await renderFrameAt(
      player,
      "a",
      { mono: 2_000, source: "video" },
      NO_DECODER
    );

    expect(fromVideo.data.frame).toMatchObject({
      source: "video",
      mono: 2_000,
      distanceMs: 0,
      recordingId: "V-1",
      videoOffsetMs: 1_000
    });
    expect(fromVideo.data.image).toMatchObject({ included: true, scaledToWidth: 1_280 });
    expect(calls[0]).toMatchObject({ kind: "video", offsetMs: 1_000, maxWidth: 1_280 });
    expect(nearShot.data.frame).toMatchObject({ source: "screenshot", distanceMs: -20 });
    expect(withoutDecoder.data.frame).toMatchObject({ source: "screenshot", distanceMs: -520 });
    expect(withoutDecoder.data.notes).toContain("no decoder");
    expect(forcedVideo.data.frame).toBeNull();
    expect(forcedVideo.images).toEqual([]);
  });

  it("tries the tab video when the close screenshot has no image in the archive", async () => {
    const video = fixtureBlob(new Uint8Array([1, 2, 3, 4]), "webm");
    const player = await WebBlackboxPlayer.open(
      await buildArchiveBytes(
        [
          ...recordingEvents(video),
          fixtureEvent("S-1", "screen.screenshot", 1_990, { shotId: "missing", format: "webp" })
        ],
        [video]
      )
    );
    const calls: DecoderCall[] = [];
    const result = await renderFrameAt(player, "a", { mono: 2_000 }, fakeDecoder(calls));
    const withoutDecoder = await renderFrameAt(player, "a", { mono: 2_000 }, NO_DECODER);

    expect(result.data.frame).toMatchObject({ source: "video", recordingId: "V-1" });
    expect(result.images).toHaveLength(1);
    expect(result.data.notes).toContainEqual(expect.stringMatching(/S-1 has no image/));
    expect(withoutDecoder.data.frame).toMatchObject({ source: "screenshot", eventId: "S-1" });
    expect(withoutDecoder.images).toEqual([]);
  });

  it("asks for exactly one known anchor", async () => {
    await expect(renderFrameAt(checkout, "a", {}, NO_DECODER)).rejects.toThrow(/exactly one/);
    await expect(
      renderFrameAt(checkout, "a", { mono: 1, eventId: "E-1" }, NO_DECODER)
    ).rejects.toThrow(/exactly one/);
    await expect(renderFrameAt(checkout, "a", { eventId: "nope" }, NO_DECODER)).rejects.toThrow(
      /Unknown eventId/
    );
  });
});

describe("ffmpeg decoder provider", () => {
  it("is off when the environment says so", async () => {
    const status = await createFfmpegDecoderProvider({ [FFMPEG_ENV]: "off" })();
    expect(status).toEqual({ decoder: null, note: `Frame decoding is off (${FFMPEG_ENV}=off).` });
  });

  it("reports a missing binary instead of failing", async () => {
    const status = await createFfmpegDecoderProvider({
      [FFMPEG_ENV]: "/nonexistent/ffmpeg-for-test"
    })();

    expect(status.decoder).toBeNull();
    expect(status.note).toContain("No ffmpeg found");
  });

  it("refuses inputs that are not a recorded video or image type", async () => {
    await expect(
      createFfmpegDecoder("ffmpeg").scaleImage(new Uint8Array([1]), "application/x-mpegurl", 100)
    ).rejects.toThrow(/not a recorded video or image type/);
  });
});

describe.skipIf(!HAS_FFMPEG)("frame_at with ffmpeg", () => {
  /** Mean colour of a JPEG, decoded to one RGB pixel by ffmpeg. */
  function pixelOf(jpeg: Uint8Array): number[] {
    const result = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-f", "jpeg_pipe", "-i", "pipe:0", "-vf", "scale=1:1"],
        ...["-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
      ],
      { input: jpeg }
    );
    return Array.from(result.stdout);
  }

  /** One second of red, then one second of blue; null when this ffmpeg has no VP8 encoder. */
  function makeVideo(): Uint8Array | null {
    const dir = mkdtempSync(join(tmpdir(), "wb-mcp-video-"));
    const output = join(dir, "red-then-blue.webm");

    try {
      const result = spawnSync("ffmpeg", [
        ...["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=10:d=1"],
        ...["-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=1"],
        ...["-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]"],
        ...["-c:v", "libvpx", "-b:v", "200k", output]
      ]);
      return result.status === 0 ? new Uint8Array(readFileSync(output)) : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("extracts the video frame at the requested time", async (context) => {
    const bytes = makeVideo();

    if (!bytes) {
      context.skip();
      return;
    }

    const video = fixtureBlob(bytes, "webm");
    const player = await WebBlackboxPlayer.open(
      await buildArchiveBytes(recordingEvents(video), [video])
    );
    const provider = createFfmpegDecoderProvider({});
    const early = await renderFrameAt(player, "a", { mono: 1_500 }, provider);
    const late = await renderFrameAt(player, "a", { mono: 2_500 }, provider);
    const [earlyRed = 0, , earlyBlue = 0] = pixelOf(early.images?.[0]?.bytes ?? new Uint8Array());
    const [lateRed = 0, , lateBlue = 0] = pixelOf(late.images?.[0]?.bytes ?? new Uint8Array());

    expect(early.data.frame).toMatchObject({ source: "video", videoOffsetMs: 500 });
    expect(early.data.image).toMatchObject({ included: true, mimeType: "image/jpeg" });
    expect(earlyRed).toBeGreaterThan(200);
    expect(earlyBlue).toBeLessThan(60);
    expect(lateBlue).toBeGreaterThan(200);
    expect(lateRed).toBeLessThan(60);
  });

  it("downscales a screenshot to maxWidth", async () => {
    const png = spawnSync("ffmpeg", [
      ...["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=400x300:d=1"],
      ...["-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]
    ]).stdout;
    const scaled = await createFfmpegDecoder("ffmpeg").scaleImage(
      new Uint8Array(png),
      "image/png",
      200
    );
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-i", "pipe:0"],
      { input: scaled.bytes }
    );

    expect(scaled.mimeType).toBe("image/jpeg");
    expect(probe.stdout.toString().trim()).toBe("200,150");
  });
});
