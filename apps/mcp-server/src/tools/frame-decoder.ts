import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Optional image decoding for `frame_at`: a video frame at a time, or a screenshot scaled down to
 * fit the size budget. Node has no WebCodecs, and an image library would be a heavy native
 * dependency, so the server uses an `ffmpeg` binary when one is available and works without it
 * (nearest screenshot only, sent as recorded).
 */

export type DecodedImage = { bytes: Uint8Array; mimeType: string };

export type FrameDecoder = {
  name: string;
  /** The frame of a video `offsetMs` from its start, at most `maxWidth` px wide, as JPEG. */
  extractVideoFrame(
    video: Uint8Array,
    videoMime: string,
    offsetMs: number,
    maxWidth: number
  ): Promise<DecodedImage>;
  /** The image re-encoded as JPEG, at most `maxWidth` px wide. */
  scaleImage(image: Uint8Array, imageMime: string, maxWidth: number): Promise<DecodedImage>;
};

/** The decoder, or null with the reason (shown to the agent). */
export type FrameDecoderStatus = { decoder: FrameDecoder | null; note: string };

export type FrameDecoderProvider = () => Promise<FrameDecoderStatus>;

/** `WEBBLACKBOX_MCP_FFMPEG`: path of the ffmpeg binary, or `off` to never decode. */
export const FFMPEG_ENV = "WEBBLACKBOX_MCP_FFMPEG";

const FFMPEG_PROBE_TIMEOUT_MS = 5_000;
const FFMPEG_RUN_TIMEOUT_MS = 30_000;
const FFMPEG_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const JPEG_QUALITY = "5";
const DISABLED_VALUES = new Set(["off", "0", "false", "no", "none"]);

/**
 * ffmpeg demuxer per recorded MIME type. Forcing the demuxer (and the `file` protocol only) keeps
 * ffmpeg from treating archive bytes as a playlist that points at other files or URLs.
 */
const DEMUXER_BY_MIME: ReadonlyArray<[RegExp, string]> = [
  [/^video\/webm/i, "matroska"],
  [/^video\/x-matroska/i, "matroska"],
  [/^video\/mp4/i, "mp4"],
  [/^image\/webp/i, "webp_pipe"],
  [/^image\/png/i, "png_pipe"],
  [/^image\/jpe?g/i, "jpeg_pipe"]
];

/** Resolves ffmpeg once: `WEBBLACKBOX_MCP_FFMPEG`, else `ffmpeg` on PATH. */
export function createFfmpegDecoderProvider(
  env: NodeJS.ProcessEnv = process.env
): FrameDecoderProvider {
  let status: Promise<FrameDecoderStatus> | null = null;

  return () => {
    status ??= probeFfmpeg(env);
    return status;
  };
}

async function probeFfmpeg(env: NodeJS.ProcessEnv): Promise<FrameDecoderStatus> {
  const configured = env[FFMPEG_ENV]?.trim();

  if (configured && DISABLED_VALUES.has(configured.toLowerCase())) {
    return { decoder: null, note: `Frame decoding is off (${FFMPEG_ENV}=${configured}).` };
  }

  const binary = configured || "ffmpeg";

  try {
    await run(binary, ["-hide_banner", "-version"], FFMPEG_PROBE_TIMEOUT_MS);
  } catch {
    return {
      decoder: null,
      note:
        `No ffmpeg found ('${binary}'): video frames cannot be extracted and screenshots are ` +
        `sent as recorded. Install ffmpeg or set ${FFMPEG_ENV} to its path.`
    };
  }

  return { decoder: createFfmpegDecoder(binary), note: `ffmpeg ('${binary}')` };
}

export function createFfmpegDecoder(binary: string): FrameDecoder {
  return {
    name: "ffmpeg",
    extractVideoFrame: (video, videoMime, offsetMs, maxWidth) =>
      decodeOneFrame(binary, { input: video, inputMime: videoMime, maxWidth, offsetMs }),
    scaleImage: (image, imageMime, maxWidth) =>
      decodeOneFrame(binary, { input: image, inputMime: imageMime, maxWidth })
  };
}

type DecodeRequest = {
  input: Uint8Array;
  inputMime: string;
  maxWidth: number;
  /** Seek target for videos. */
  offsetMs?: number;
};

async function decodeOneFrame(binary: string, request: DecodeRequest): Promise<DecodedImage> {
  const demuxer = DEMUXER_BY_MIME.find(([pattern]) => pattern.test(request.inputMime))?.[1];

  if (!demuxer) {
    throw new Error(`Cannot decode '${request.inputMime}': not a recorded video or image type.`);
  }

  const seek =
    request.offsetMs === undefined
      ? []
      : ["-ss", (Math.max(0, request.offsetMs) / 1000).toFixed(3)];
  const width = Math.max(2, Math.floor(request.maxWidth / 2) * 2);
  const dir = await mkdtemp(join(tmpdir(), "wb-mcp-frame-"));
  const inputPath = join(dir, "input");

  try {
    await writeFile(inputPath, request.input);
    const output = await run(
      binary,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file",
        ...seek,
        "-f",
        demuxer,
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-vf",
        `scale='trunc(min(${width},iw)/2)*2':-2`,
        "-q:v",
        JPEG_QUALITY,
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "pipe:1"
      ],
      FFMPEG_RUN_TIMEOUT_MS
    );

    if (output.byteLength === 0) {
      throw new Error("ffmpeg produced no frame (the time may be past the end of the video).");
    }

    return { bytes: output, mimeType: "image/jpeg" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(binary: string, args: string[], timeout: number): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      args,
      { encoding: "buffer", timeout, maxBuffer: FFMPEG_MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString("utf8").trim().split("\n").slice(-3).join(" ");
          reject(new Error(`${binary} failed: ${detail || error.message}`));
          return;
        }

        resolvePromise(new Uint8Array(stdout));
      }
    );
  });
}
