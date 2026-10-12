// Tests for the video bundling step of the player build (scripts/lib/bundle-videos.mjs).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bundleVideosIntoPlayer,
  findGuideVideos,
  PLAYER_VIDEOS_METADATA
} from "./bundle-videos.mjs";

let workDir = "";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "wb-bundle-videos-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function videosDir(files) {
  const dir = join(workDir, "videos");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
  }
  return dir;
}

describe("findGuideVideos", () => {
  it("keeps the known <id>.<lang>.mp4 files, in guide order", async () => {
    const dir = await videosDir({
      "open-in-player.ru.mp4": "c",
      "install.ru.mp4": "aa",
      "record-and-export.ru.mp4": "bbb",
      "install.ru.ass": "captions",
      "player-tools.ru.mp4": "unknown id",
      "install.mp4": "no language",
      "empty.ru.mp4": ""
    });

    expect(await findGuideVideos(dir)).toEqual([
      { id: "install", lang: "ru", file: "install.ru.mp4", size: 2 },
      { id: "record-and-export", lang: "ru", file: "record-and-export.ru.mp4", size: 3 },
      { id: "open-in-player", lang: "ru", file: "open-in-player.ru.mp4", size: 1 }
    ]);
  });

  it("treats a missing folder as no videos", async () => {
    expect(await findGuideVideos(join(workDir, "absent"))).toEqual([]);
  });
});

describe("bundleVideosIntoPlayer", () => {
  it("copies the videos and writes videos.json next to the extension", async () => {
    const dir = await videosDir({ "install.ru.mp4": "video bytes" });
    const buildDir = join(workDir, "build");

    const result = await bundleVideosIntoPlayer({ videosDir: dir, playerBuildDir: buildDir });

    expect(result.bundled).toBe(true);
    expect(await readFile(join(buildDir, "extension", "videos", "install.ru.mp4"), "utf8")).toBe(
      "video bytes"
    );
    const metadata = JSON.parse(
      await readFile(join(buildDir, "extension", PLAYER_VIDEOS_METADATA), "utf8")
    );
    expect(metadata).toEqual({
      videos: [{ id: "install", lang: "ru", file: "install.ru.mp4", size: 11 }]
    });
  });

  it("removes stale videos when the source has none", async () => {
    const buildDir = join(workDir, "build");
    await mkdir(join(buildDir, "extension", "videos"), { recursive: true });
    await writeFile(join(buildDir, "extension", "videos", "install.ru.mp4"), "old");
    await writeFile(join(buildDir, "extension", PLAYER_VIDEOS_METADATA), "{}");

    const result = await bundleVideosIntoPlayer({
      videosDir: join(workDir, "absent"),
      playerBuildDir: buildDir
    });

    expect(result).toEqual({ bundled: false, videos: [] });
    await expect(stat(join(buildDir, "extension", "videos"))).rejects.toThrow();
    await expect(stat(join(buildDir, "extension", PLAYER_VIDEOS_METADATA))).rejects.toThrow();
  });
});
