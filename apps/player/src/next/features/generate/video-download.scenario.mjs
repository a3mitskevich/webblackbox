// e2e:player scenario "download the clean tab video" (imported by generate.e2e.mjs): a synthetic
// archive carries a real Chrome MediaRecorder recording (timeslice chunks, like the extension's
// tab video); the Generate menu saves it, and the saved file must be a WebM that Chrome plays,
// with a finite duration close to the recording's and working seeks.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEncryptedArchive } from "../../../../scripts/lib/encrypted-archive.mjs";
import { recordCanvasWebm } from "../../../../scripts/lib/media-recorder-webm.mjs";
import { navigateFresh, openEncrypted } from "../../../../scripts/lib/next-e2e.mjs";
import {
  buildSyntheticSession,
  SYNTHETIC_PASSPHRASE
} from "../../../../scripts/lib/synthetic-session.mjs";
import { withTabVideo } from "../../../../scripts/lib/synthetic-video.mjs";

const POLL_MS = 100;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RECORDING_MS = 3_000;
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;
/** The saved file's duration (frame timestamps) may differ a little from the wall clock. */
const DURATION_TOLERANCE_S = 0.6;
const FILE_NAME = /^app\.example\.test-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-synthetic\.webm$/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first new, fully written `.webm` in `directory`. */
async function waitForDownload(directory, before) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const name = (await readdir(directory)).find(
      (entry) => !before.includes(entry) && entry.endsWith(".webm")
    );

    if (name) {
      const path = join(directory, name);
      const size = (await stat(path)).size;
      await delay(300);

      if (size > 0 && (await stat(path)).size === size) {
        return { name, path };
      }
    }

    await delay(POLL_MS);
  }

  throw new Error(`No .webm download in ${directory}`);
}

/** Loads WebM bytes into a <video> of the page and reports duration, seeking and playback. */
async function probeVideo(ctx, bytes) {
  return ctx.evaluate(`(async () => {
    const binary = atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))});
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([data], { type: "video/webm" }));
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    const timeout = (ms, what) =>
      new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms));
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error("media error " + (video.error && video.error.code)));
        }),
        timeout(8000, "no metadata")
      ]);
      const duration = video.duration;
      const seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
      if (!Number.isFinite(duration)) {
        return { duration: String(duration), seekableEnd: String(seekableEnd) };
      }
      video.currentTime = duration / 2;
      await Promise.race([
        new Promise((resolve) => { video.onseeked = resolve; }),
        timeout(5000, "no seeked event")
      ]);
      const seekedTo = video.currentTime;
      await video.play();
      await Promise.race([
        new Promise((resolve) => {
          video.ontimeupdate = () => { if (video.currentTime > seekedTo + 0.1) resolve(); };
        }),
        timeout(5000, "playback did not advance")
      ]);
      video.pause();
      return { duration, seekableEnd, seekedTo, playedTo: video.currentTime, width: video.videoWidth };
    } finally {
      URL.revokeObjectURL(url);
    }
  })()`);
}

/** The Generate menu saves the tab video as a playable, seekable WebM named after the session. */
export async function downloadTabVideo(ctx) {
  const recording = await recordCanvasWebm(ctx, {
    durationMs: RECORDING_MS,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT
  });
  const session = withTabVideo(buildSyntheticSession(), [
    {
      chunks: recording.chunks,
      mime: recording.mime,
      startOffsetMs: 1_000,
      durationMs: recording.durationMs,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT
    }
  ]);
  const archivePath = join(ctx.artifactsDir, "synthetic-video.webblackbox");
  await writeFile(archivePath, await createEncryptedArchive(session));
  const downloadPath = join(ctx.artifactsDir, "video-downloads");
  await mkdir(downloadPath, { recursive: true });

  await navigateFresh(ctx.client, `${ctx.origin}/?lang=en`);
  await openEncrypted(ctx.client, archivePath, SYNTHETIC_PASSPHRASE);
  await ctx.client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath,
    eventsEnabled: true
  });
  await ctx.waitForSelector(ctx.testId("transport-video"), "No video button on the transport");

  await ctx.click("generate-button");
  await ctx.waitForSelector(ctx.testId("generate-video"), "No Download video item");
  const detail = await ctx.evaluate(
    `document.querySelector('${ctx.testId("generate-video-detail")}').textContent`
  );
  ctx.assert(/s · [\d.,]+ KB$/.test(detail), "The item shows no duration and size", detail);
  const before = await readdir(downloadPath);
  await ctx.click("generate-video");
  const file = await waitForDownload(downloadPath, before);
  ctx.assert(FILE_NAME.test(file.name), "Unexpected video file name", file.name);

  const saved = new Uint8Array(await readFile(file.path));
  const raw = Buffer.concat(recording.chunks);
  const probe = await probeVideo(ctx, saved);
  const rawProbe = await probeVideo(ctx, raw);
  const expected = recording.durationMs / 1_000;
  ctx.assert(
    typeof probe.duration === "number" &&
      Math.abs(probe.duration - expected) <= DURATION_TOLERANCE_S,
    "The saved video has no finite duration close to the recording's",
    { probe, expected }
  );
  ctx.assert(
    probe.seekableEnd === probe.duration && Math.abs(probe.seekedTo - probe.duration / 2) < 0.2,
    "The saved video does not seek",
    probe
  );
  ctx.assert(probe.width === FRAME_WIDTH, "The saved video has the wrong frame size", probe);
  return {
    file: file.name,
    detail,
    bytes: saved.length,
    recordedBytes: raw.length,
    chunks: recording.chunks.length,
    expected,
    probe,
    // Chrome's own chunks have no duration: the reason the file is fixed on save.
    rawDuration: rawProbe.duration
  };
}
