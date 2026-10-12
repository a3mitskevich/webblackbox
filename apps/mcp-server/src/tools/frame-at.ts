import type { ScreenRecordingSegment, WebBlackboxPlayer } from "@webblackbox/player-sdk";
import * as z from "zod";

import type { UntrustedImage } from "../untrusted-content.js";
import {
  anchorInputSchema,
  findNearestScreenshots,
  listScreenshots,
  resolveAnchor,
  toScreenshotPointer,
  type NearestScreenshots,
  type ResolvedAnchor,
  type ScreenshotRef
} from "./archive-lookup.js";
import type {
  DecodedImage,
  FrameDecoder,
  FrameDecoderProvider,
  FrameDecoderStatus
} from "./frame-decoder.js";
import { defineArchiveTool, type ArchiveToolOutput } from "./registry.js";
import { round2 } from "./values.js";

const DEFAULT_MAX_BYTES = 1_000_000;
const MIN_MAX_BYTES = 20_000;
const MAX_MAX_BYTES = 5_000_000;
const DEFAULT_SCALE_WIDTH = 1280;
const MIN_WIDTH = 160;
const MAX_WIDTH = 3840;
/** In `auto`, a screenshot this close to the time wins over a decoded video frame. */
const AUTO_SCREENSHOT_TOLERANCE_MS = 250;
/** Each re-encode that still exceeds `maxBytes` retries at this share of the width. */
const SHRINK_FACTOR = 0.7;
const MAX_SHRINK_ATTEMPTS = 4;
const MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  webp: "image/webp",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg"
};

export const frameAtInput = {
  ...anchorInputSchema,
  source: z
    .enum(["auto", "screenshot", "video"])
    .optional()
    .describe(
      "auto (default): a screenshot within 250 ms, else the tab video frame (needs ffmpeg), " +
        "else the nearest screenshot. screenshot / video: only that source."
    ),
  includeImage: z
    .boolean()
    .optional()
    .describe("Return the image block (default true); false returns only the metadata."),
  maxBytes: z
    .number()
    .int()
    .min(MIN_MAX_BYTES)
    .max(MAX_MAX_BYTES)
    .optional()
    .describe(
      `Largest image to return, in bytes (default ${DEFAULT_MAX_BYTES}). A larger image is ` +
        "downscaled when ffmpeg is available, otherwise withheld with the reason."
    ),
  maxWidth: z
    .number()
    .int()
    .min(MIN_WIDTH)
    .max(MAX_WIDTH)
    .optional()
    .describe(
      `Scale the image down to this width in px (video frames default to ${DEFAULT_SCALE_WIDTH}; ` +
        "screenshots are sent at their recorded size unless this is set). Needs ffmpeg."
    )
};

export type FrameAtArgs = {
  mono?: number;
  eventId?: string;
  actionId?: string;
  offsetMs?: number;
  source?: "auto" | "screenshot" | "video";
  includeImage?: boolean;
  maxBytes?: number;
  maxWidth?: number;
};

type FrameMeta = {
  source: "screenshot" | "video";
  /** Session time of the frame. */
  mono: number;
  /** Frame time minus the requested time. */
  distanceMs: number;
  eventId: string | null;
  shotId: string | null;
  reason: string | null;
  recordingId: string | null;
  /** Offset into the video segment that was decoded. */
  videoOffsetMs: number | null;
  viewport: ScreenshotRef["viewport"];
  pointer: ScreenshotRef["pointer"];
};

type ImageMeta = {
  included: boolean;
  mimeType: string | null;
  bytes: number | null;
  /** Width in px the image was re-encoded to, or null when it is sent as recorded. */
  scaledToWidth: number | null;
  withheldReason: string | null;
};

type FrameChoice = {
  frame: FrameMeta | null;
  image: DecodedImage | null;
  /** Width the decoder already scaled the image to (video frames). */
  decodedWidth: number | null;
  notes: string[];
};

export const frameAtTool = defineArchiveTool({
  name: "frame_at",
  description:
    "Show what the page looked like at a moment: the nearest screenshot (or the tab video frame " +
    "when ffmpeg is available) as an image, with its exact time and distance from the requested " +
    "time. Anchor on mono, an eventId or an actionId; offsetMs looks before/after.",
  inputSchema: frameAtInput,
  run: async (args, archive, services) =>
    renderFrameAt(await archive.open(), archive.path, args, services.frameDecoder)
});

export async function renderFrameAt(
  player: WebBlackboxPlayer,
  archivePath: string,
  args: FrameAtArgs,
  decoderProvider: FrameDecoderProvider
): Promise<ArchiveToolOutput> {
  const anchor = resolveAnchor(player, args);
  const includeImage = args.includeImage !== false;
  const shots = listScreenshots(player);
  const near = findNearestScreenshots(shots, anchor.mono);
  const segments = player.getScreenRecordings();
  const covering =
    segments.find(
      (segment) => segment.startMono <= anchor.mono && anchor.mono <= segment.endMono
    ) ?? null;
  const decoderStatus = await decoderProvider();
  const choice = await chooseFrame({
    player,
    anchor,
    source: args.source ?? "auto",
    includeImage,
    near,
    covering,
    decoderStatus,
    maxWidth: args.maxWidth
  });
  const fitted =
    includeImage && choice.image
      ? await fitImage(choice, {
          maxBytes: args.maxBytes ?? DEFAULT_MAX_BYTES,
          maxWidth: args.maxWidth,
          decoderStatus
        })
      : null;
  const images: UntrustedImage[] =
    fitted?.image && choice.frame
      ? [
          {
            bytes: fitted.image.bytes,
            mimeType: fitted.image.mimeType,
            caption:
              `Frame of the ${choice.frame.source} at mono ${choice.frame.mono} ` +
              `(${choice.frame.distanceMs} ms from the requested ${round2(anchor.mono)}).`
          }
        ]
      : [];

  return {
    data: {
      archive: archivePath,
      anchor,
      frame: choice.frame,
      image: describeImage(includeImage, choice, fitted),
      neighbours: {
        before: near.before ? toScreenshotPointer(near.before, anchor.mono) : null,
        after: near.after ? toScreenshotPointer(near.after, anchor.mono) : null
      },
      screenshots: { total: shots.length },
      video: {
        segments: segments.length,
        covering: covering
          ? {
              recordingId: covering.recordingId,
              startMono: covering.startMono,
              endMono: covering.endMono,
              complete: covering.missingChunks.length === 0
            }
          : null,
        decoder: decoderStatus.decoder?.name ?? null,
        decoderNote: decoderStatus.note
      },
      notes: fitted?.note ? [...choice.notes, fitted.note] : choice.notes
    },
    images
  };
}

type ChooseFrameInput = {
  player: WebBlackboxPlayer;
  anchor: ResolvedAnchor;
  source: "auto" | "screenshot" | "video";
  includeImage: boolean;
  near: NearestScreenshots;
  covering: ScreenRecordingSegment | null;
  decoderStatus: FrameDecoderStatus;
  maxWidth: number | undefined;
};

async function chooseFrame(input: ChooseFrameInput): Promise<FrameChoice> {
  const { anchor, near, source } = input;
  const screenshotIsClose =
    near.nearest !== null &&
    Math.abs(near.nearest.mono - anchor.mono) <= AUTO_SCREENSHOT_TOLERANCE_MS;
  const notes: string[] = [];

  if (source === "screenshot" || (source === "auto" && screenshotIsClose)) {
    return screenshotChoice(input, notes);
  }

  const videoReason = videoUnavailableReason(input);

  if (videoReason) {
    notes.push(videoReason);
  } else {
    try {
      return await videoChoice(input, notes);
    } catch (error) {
      notes.push(`Video frame failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (source === "video") {
    return { frame: null, image: null, decodedWidth: null, notes };
  }

  return screenshotChoice(input, notes);
}

function videoUnavailableReason(input: ChooseFrameInput): string | null {
  if (!input.covering) {
    return "No tab video covers this time.";
  }

  if (input.covering.missingChunks.length > 0) {
    return `The tab video ${input.covering.recordingId} misses chunks; it cannot be decoded.`;
  }

  return input.decoderStatus.decoder ? null : input.decoderStatus.note;
}

async function screenshotChoice(input: ChooseFrameInput, notes: string[]): Promise<FrameChoice> {
  const shot = input.near.nearest;

  if (!shot) {
    notes.push("The archive holds no screenshots.");
    return { frame: null, image: null, decodedWidth: null, notes };
  }

  const frame: FrameMeta = {
    source: "screenshot",
    mono: shot.mono,
    distanceMs: round2(shot.mono - input.anchor.mono),
    eventId: shot.eventId,
    shotId: shot.shotId,
    reason: shot.reason,
    recordingId: null,
    videoOffsetMs: null,
    viewport: shot.viewport,
    pointer: shot.pointer
  };

  if (!input.includeImage) {
    return { frame, image: null, decodedWidth: null, notes };
  }

  const blob = shot.shotId ? await input.player.getBlob(shot.shotId) : null;

  if (!blob) {
    notes.push(`Screenshot ${shot.eventId} has no image in the archive (shotId ${shot.shotId}).`);
    return { frame, image: null, decodedWidth: null, notes };
  }

  const mimeType = blob.mime.startsWith("image/")
    ? blob.mime
    : (MIME_BY_FORMAT[shot.format ?? ""] ?? "image/webp");

  return { frame, image: { bytes: blob.bytes, mimeType }, decodedWidth: null, notes };
}

async function videoChoice(input: ChooseFrameInput, notes: string[]): Promise<FrameChoice> {
  const segment = input.covering;
  const decoder = input.decoderStatus.decoder;

  if (!segment || !decoder) {
    throw new Error("no video segment or decoder");
  }

  const offsetMs = Math.max(0, input.anchor.mono - segment.startMono);
  const width = input.maxWidth ?? DEFAULT_SCALE_WIDTH;
  const frame: FrameMeta = {
    source: "video",
    mono: input.anchor.mono,
    distanceMs: 0,
    eventId: null,
    shotId: null,
    reason: null,
    recordingId: segment.recordingId,
    videoOffsetMs: round2(offsetMs),
    viewport: null,
    pointer: null
  };

  notes.push(
    "Video frame times map session time onto the segment start; expect a frame or two of skew."
  );

  if (!input.includeImage) {
    return { frame, image: null, decodedWidth: null, notes };
  }

  const video = await input.player.getScreenRecordingBlob(segment.recordingId);
  const lastFrameMs = Math.max(0, video.durationMs - 1);
  const image = await decoder.extractVideoFrame(
    video.bytes,
    video.mime,
    Math.min(offsetMs, lastFrameMs),
    width
  );

  return { frame, image, decodedWidth: width, notes };
}

type FitOptions = {
  maxBytes: number;
  maxWidth: number | undefined;
  decoderStatus: FrameDecoderStatus;
};

type FittedImage = {
  image: DecodedImage | null;
  scaledToWidth: number | null;
  withheldReason: string | null;
  /** Why the image is sent at its recorded size although a smaller one was asked for. */
  note: string | null;
};

/** Keeps the image within `maxBytes` (and `maxWidth` when asked), re-encoding with ffmpeg. */
async function fitImage(choice: FrameChoice, options: FitOptions): Promise<FittedImage> {
  const image = choice.image;

  if (!image) {
    return { image: null, scaledToWidth: null, withheldReason: null, note: null };
  }

  const fits = image.bytes.byteLength <= options.maxBytes;
  const alreadyScaled = choice.decodedWidth !== null;
  const wantsWidth = !alreadyScaled && options.maxWidth !== undefined;

  if (fits && !wantsWidth) {
    return { image, scaledToWidth: choice.decodedWidth, withheldReason: null, note: null };
  }

  // A recorded image that fits the byte budget is still sent when it cannot be scaled to maxWidth.
  const unscaled = (reason: string): FittedImage =>
    fits
      ? {
          image,
          scaledToWidth: choice.decodedWidth,
          withheldReason: null,
          note: `Sent at the recorded size, not scaled to maxWidth: ${reason}`
        }
      : {
          image: null,
          scaledToWidth: null,
          withheldReason:
            `The image is ${image.bytes.byteLength} bytes, over maxBytes ${options.maxBytes}, ` +
            `and cannot be downscaled: ${reason}`,
          note: null
        };
  const decoder = options.decoderStatus.decoder;

  if (!decoder) {
    return unscaled(options.decoderStatus.note);
  }

  try {
    return await shrinkImage(decoder, image, {
      maxBytes: options.maxBytes,
      startWidth: options.maxWidth ?? DEFAULT_SCALE_WIDTH,
      alreadyScaled
    });
  } catch (error) {
    return unscaled(`${decoder.name} failed: ${error instanceof Error ? error.message : error}`);
  }
}

async function shrinkImage(
  decoder: FrameDecoder,
  image: DecodedImage,
  options: { maxBytes: number; startWidth: number; alreadyScaled: boolean }
): Promise<FittedImage> {
  let width = options.alreadyScaled
    ? Math.floor(options.startWidth * SHRINK_FACTOR)
    : options.startWidth;

  for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS; attempt += 1) {
    const scaled = await decoder.scaleImage(image.bytes, image.mimeType, width);

    if (scaled.bytes.byteLength <= options.maxBytes) {
      return { image: scaled, scaledToWidth: width, withheldReason: null, note: null };
    }

    width = Math.max(MIN_WIDTH, Math.floor(width * SHRINK_FACTOR));
  }

  return {
    image: null,
    scaledToWidth: null,
    withheldReason: `The image stays over maxBytes ${options.maxBytes} even when downscaled.`,
    note: null
  };
}

function describeImage(
  includeImage: boolean,
  choice: FrameChoice,
  fitted: FittedImage | null
): ImageMeta {
  const withheld = (reason: string): ImageMeta => ({
    included: false,
    mimeType: null,
    bytes: null,
    scaledToWidth: null,
    withheldReason: reason
  });

  if (!includeImage) {
    return withheld("includeImage=false");
  }

  if (!fitted?.image) {
    return withheld(
      fitted?.withheldReason ??
        (choice.frame ? "The frame has no image in the archive." : "No frame for this time.")
    );
  }

  return {
    included: true,
    mimeType: fitted.image.mimeType,
    bytes: fitted.image.bytes.byteLength,
    scaledToWidth: fitted.scaledToWidth,
    withheldReason: null
  };
}
