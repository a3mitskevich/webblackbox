/**
 * The usage videos the player build may ship next to the extension (`extension/videos.json`, see
 * scripts/lib/bundle-videos.mjs). Fetched JSON is untrusted input: every entry is validated, and
 * the file name must be exactly `<id>.<lang>.mp4` for a known id, so it cannot point elsewhere.
 */
export const GUIDE_VIDEO_IDS = ["install", "record-and-export", "open-in-player"] as const;

export type GuideVideoId = (typeof GUIDE_VIDEO_IDS)[number];

export type GuideVideo = {
  id: GuideVideoId;
  lang: string;
  file: string;
  size: number;
};

export const GUIDE_VIDEOS_URL = "extension/videos.json";

const LANG_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/u;

function isGuideVideoId(value: unknown): value is GuideVideoId {
  return typeof value === "string" && (GUIDE_VIDEO_IDS as readonly string[]).includes(value);
}

function parseGuideVideo(value: unknown): GuideVideo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;

  if (
    !isGuideVideoId(row.id) ||
    typeof row.lang !== "string" ||
    !LANG_PATTERN.test(row.lang) ||
    row.file !== `${row.id}.${row.lang}.mp4` ||
    typeof row.size !== "number" ||
    !Number.isFinite(row.size) ||
    row.size <= 0
  ) {
    return null;
  }

  return { id: row.id, lang: row.lang, file: row.file, size: row.size };
}

/** The valid entries of `videos.json`; anything malformed is dropped, never trusted. */
export function parseGuideVideos(value: unknown): GuideVideo[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  const list = (value as Record<string, unknown>).videos;

  if (!Array.isArray(list)) {
    return [];
  }

  return list.map(parseGuideVideo).filter((video): video is GuideVideo => video !== null);
}

/** One video per id, in guide order: the Player's language when there is one, else the first. */
export function pickGuideVideos(videos: readonly GuideVideo[], locale: string): GuideVideo[] {
  const language = locale.split("-")[0];

  return GUIDE_VIDEO_IDS.flatMap((id) => {
    const variants = videos.filter((video) => video.id === id);
    const chosen =
      variants.find((video) => video.lang === locale) ??
      variants.find((video) => video.lang.split("-")[0] === language) ??
      variants[0];
    return chosen ? [chosen] : [];
  });
}

export function guideVideoUrl(video: GuideVideo): string {
  return `extension/videos/${video.file}`;
}

/** Reads `extension/videos.json` same-origin; any failure means "no videos", not an error. */
export async function fetchGuideVideos(fetchImpl: typeof fetch = fetch): Promise<GuideVideo[]> {
  try {
    const response = await fetchImpl(GUIDE_VIDEOS_URL);
    return response.ok ? parseGuideVideos(await response.json()) : [];
  } catch {
    return [];
  }
}
