import { describe, expect, it } from "vitest";

import { fetchGuideVideos, guideVideoUrl, parseGuideVideos, pickGuideVideos } from "./videos.js";

const INSTALL_RU = { id: "install", lang: "ru", file: "install.ru.mp4", size: 2048 };

describe("guide videos", () => {
  it("keeps valid entries and drops malformed or unknown ones", () => {
    expect(
      parseGuideVideos({
        videos: [
          INSTALL_RU,
          { id: "install", lang: "ru", file: "../../evil.mp4", size: 1 },
          { id: "player-tools", lang: "ru", file: "player-tools.ru.mp4", size: 1 },
          { id: "open-in-player", lang: "russian", file: "open-in-player.russian.mp4", size: 1 },
          { id: "record-and-export", lang: "ru", file: "record-and-export.ru.mp4", size: 0 },
          "not an object"
        ]
      })
    ).toEqual([INSTALL_RU]);
    expect(parseGuideVideos(null)).toEqual([]);
    expect(parseGuideVideos({ videos: "nope" })).toEqual([]);
  });

  it("picks one video per topic, in guide order, preferring the Player's language", () => {
    const videos = parseGuideVideos({
      videos: [
        { id: "open-in-player", lang: "ru", file: "open-in-player.ru.mp4", size: 1 },
        { id: "install", lang: "en", file: "install.en.mp4", size: 1 },
        INSTALL_RU
      ]
    });

    expect(pickGuideVideos(videos, "ru").map((video) => video.file)).toEqual([
      "install.ru.mp4",
      "open-in-player.ru.mp4"
    ]);
    expect(pickGuideVideos(videos, "en").map((video) => video.file)).toEqual([
      "install.en.mp4",
      "open-in-player.ru.mp4"
    ]);
  });

  it("serves videos next to the bundled extension", () => {
    expect(guideVideoUrl(parseGuideVideos({ videos: [INSTALL_RU] })[0]!)).toBe(
      "extension/videos/install.ru.mp4"
    );
  });

  it("treats a missing or broken videos.json as no videos", async () => {
    const notFound = async () => new Response("nope", { status: 404 });
    const broken = async () => new Response("{", { status: 200 });
    const offline = async () => {
      throw new TypeError("offline");
    };

    expect(await fetchGuideVideos(notFound as typeof fetch)).toEqual([]);
    expect(await fetchGuideVideos(broken as typeof fetch)).toEqual([]);
    expect(await fetchGuideVideos(offline as typeof fetch)).toEqual([]);
  });
});
