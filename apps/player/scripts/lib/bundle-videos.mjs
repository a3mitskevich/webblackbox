// Ships the usage videos inside the player build, next to the bundled extension: copies
// <id>.<lang>.mp4 for the known videos from a git-ignored folder (by default
// apps/extension/demo-video-output, where apps/extension/scripts/demo-video writes them) to
// <build>/extension/videos/ and writes extension/videos.json ({ videos: [{ id, lang, file, size }] }).
// The guide view reads that list; without it the guide simply has no video section.
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PLAYER_EXTENSION_DIR } from "./bundle-extension.mjs";

export const PLAYER_VIDEOS_DIR = "videos";
export const PLAYER_VIDEOS_METADATA = "videos.json";
/** The videos the guide knows how to title, in the order it shows them. */
export const GUIDE_VIDEO_IDS = Object.freeze(["install", "record-and-export", "open-in-player"]);

const VIDEO_FILE = /^([a-z][a-z-]*)\.([a-z]{2}(?:-[A-Z]{2})?)\.mp4$/u;

/** The known videos present in `videosDir`, in guide order (an absent folder means none). */
export async function findGuideVideos(videosDir) {
  let names;

  try {
    names = await readdir(videosDir);
  } catch {
    return [];
  }

  const found = [];

  for (const name of names) {
    const match = VIDEO_FILE.exec(name);

    if (!match || !GUIDE_VIDEO_IDS.includes(match[1])) {
      continue;
    }

    const info = await stat(join(videosDir, name));

    if (info.isFile() && info.size > 0) {
      found.push({ id: match[1], lang: match[2], file: name, size: info.size });
    }
  }

  return found.sort(
    (a, b) =>
      GUIDE_VIDEO_IDS.indexOf(a.id) - GUIDE_VIDEO_IDS.indexOf(b.id) || a.lang.localeCompare(b.lang)
  );
}

/**
 * Copies the videos into the player build and writes the list next to them. With no videos the
 * build stays valid: stale copies are removed and the result is `{ bundled: false }`.
 */
export async function bundleVideosIntoPlayer({ videosDir, playerBuildDir }) {
  const extensionDir = join(playerBuildDir, PLAYER_EXTENSION_DIR);
  const targetDir = join(extensionDir, PLAYER_VIDEOS_DIR);
  await rm(targetDir, { recursive: true, force: true });
  await rm(join(extensionDir, PLAYER_VIDEOS_METADATA), { force: true });

  const videos = await findGuideVideos(videosDir);

  if (videos.length === 0) {
    return { bundled: false, videos: [] };
  }

  await mkdir(targetDir, { recursive: true });

  for (const video of videos) {
    await copyFile(join(videosDir, video.file), join(targetDir, video.file));
  }

  await writeFile(
    join(extensionDir, PLAYER_VIDEOS_METADATA),
    `${JSON.stringify({ videos }, null, 2)}\n`
  );

  return { bundled: true, videos };
}
