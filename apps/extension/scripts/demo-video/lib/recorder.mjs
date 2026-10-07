// Screen capture of the demo window's rectangle (Windows ffmpeg, gdigrab) and the final encode
// with burned-in captions (WSL ffmpeg + libass, fonts from C:\Windows\Fonts).
import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

import { buildAss } from "./captions.mjs";

const execFileAsync = promisify(execFile);
const WINDOWS_FFMPEG = "/mnt/c/ProgramData/chocolatey/bin/ffmpeg.exe";
const WINDOWS_FONTS_DIR = "/mnt/c/Windows/Fonts";
const FIRST_FRAME_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 30_000;

export const CAPTURE_FPS = 30;
export const CAPTION_BAR_HEIGHT = 110;

/**
 * Starts recording `rect` (screen pixels, even width/height) to `outWin` (a Windows path, .mkv).
 * Resolves once frames flow; `t0` is the wall-clock time of the first frame, so caption marks
 * can be expressed as `Date.now() - t0`.
 */
export async function startCapture({ rect, outWin, log }) {
  const args = [
    "-hide_banner",
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    String(CAPTURE_FPS),
    "-offset_x",
    String(rect.left),
    "-offset_y",
    String(rect.top),
    "-video_size",
    `${rect.width}x${rect.height}`,
    "-draw_mouse",
    "1",
    "-i",
    "desktop",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "14",
    "-pix_fmt",
    "yuv420p",
    outWin
  ];
  const child = spawn(WINDOWS_FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  const t0 = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ffmpeg produced no frames: ${stderr.slice(-800)}`)),
      FIRST_FRAME_TIMEOUT_MS
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg exited early (${code}): ${stderr.slice(-800)}`));
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-20_000);
      const match = /frame=\s*(\d+)/u.exec(text);
      if (match && Number(match[1]) > 0) {
        clearTimeout(timer);
        resolve(Date.now() - (Number(match[1]) / CAPTURE_FPS) * 1000);
      }
    });
  });
  log?.(`capture started ${rect.width}x${rect.height}+${rect.left}+${rect.top}`);

  async function stop() {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.write("q");
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  return { t0, stop };
}

/** Encodes the final video: raw take + caption bar + burned captions, H.264 CRF 23, yuv420p. */
export async function renderFinal({ rawWsl, assWsl, outWsl, cues, width, height, title }) {
  writeFileSync(
    assWsl,
    buildAss({ cues, width, videoHeight: height, barHeight: CAPTION_BAR_HEIGHT, title })
  );
  const filter = [
    `pad=${width}:${height + CAPTION_BAR_HEIGHT}:0:0:color=0x15171c`,
    `ass=filename=${escapeFilterPath(assWsl)}:fontsdir=${escapeFilterPath(WINDOWS_FONTS_DIR)}`
  ].join(",");
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      rawWsl,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      outWsl
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  );
}

/** Duration of a media file in ms (ffprobe). */
export async function probeDurationMs(fileWsl) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    fileWsl
  ]);
  return Math.round(Number.parseFloat(stdout.trim()) * 1000);
}

function escapeFilterPath(path) {
  return path.replace(/\\/gu, "/").replace(/:/gu, "\\:").replace(/'/gu, "\\'");
}
