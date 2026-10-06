import { Menu } from "@base-ui/react/menu";
import type { ScreenRecordingSegment } from "@webblackbox/player-sdk";
import { Download, Film, Files, type LucideIcon } from "lucide-react";
import { memo } from "react";

import { formatClock } from "../../../core/format.js";
import type { PlayerI18n, PlayerLocale } from "../../../lib/i18n.js";
import { Hint } from "../../components/hint.js";
import { toastManager } from "../../components/toasts.js";
import { useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { generateMessages, type GenerateTranslate } from "./messages.js";
import {
  describeMissingChunks,
  downloadVideoSegment,
  videoSourceOf,
  type VideoDownloadResult,
  type VideoUnavailableReason
} from "./video-export.js";

const ICON_PROPS = { size: 16, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };

/** One "download video" entry of the menus and the command palette. */
export type VideoEntry = {
  id: string;
  label: string;
  /** Duration and size, or why the entry is disabled. */
  detail: string;
  disabled: boolean;
  segments: readonly ScreenRecordingSegment[];
  icon: LucideIcon;
  testId: string;
};

function segmentDetail(
  archive: LoadedArchive,
  segment: ScreenRecordingSegment,
  ranged: boolean,
  t: GenerateTranslate,
  i18n: PlayerI18n
): string {
  if (segment.missingChunks.length > 0) {
    return t("videoMissingChunks", {
      chunks: segment.missingChunks.map((index) => String(index + 1)).join(", "),
      total: segment.chunkCount
    });
  }

  const size = i18n.formatByteSize(segment.size);

  if (!ranged) {
    return t("videoDetail", { duration: i18n.formatSeconds(segment.durationMs), size });
  }

  const { minMono } = archive.model;
  return t("videoPartDetail", {
    from: formatClock(segment.startMono - minMono, i18n.locale),
    to: formatClock(segment.endMono - minMono, i18n.locale),
    size
  });
}

function unavailableDetail(reason: VideoUnavailableReason, t: GenerateTranslate): string {
  if (reason.kind === "lite") {
    return t("videoNoneLite");
  }

  return reason.kind === "failed"
    ? t("videoNoneFailed", { error: reason.message })
    : t("videoNone");
}

/**
 * The "download video" entries: one per segment (with its time span when there are several),
 * "all parts" when more than one can be saved, or one disabled entry that says why there is
 * nothing to save.
 */
export function buildVideoEntries(
  archive: LoadedArchive,
  t: GenerateTranslate,
  i18n: PlayerI18n
): VideoEntry[] {
  const source = videoSourceOf(archive);

  if (source.unavailable) {
    return [
      {
        id: "video",
        label: t("itemDownloadVideo"),
        detail: unavailableDetail(source.unavailable, t),
        disabled: true,
        segments: [],
        icon: Film,
        testId: "generate-video"
      }
    ];
  }

  const multiple = source.segments.length > 1;
  const entries: VideoEntry[] = source.segments.map((segment) => ({
    id: multiple ? `video-part-${segment.part}` : "video",
    label: multiple ? t("itemDownloadVideoPart", { part: segment.part }) : t("itemDownloadVideo"),
    detail: segmentDetail(archive, segment, multiple, t, i18n),
    disabled: segment.missingChunks.length > 0,
    segments: [segment],
    icon: Film,
    testId: multiple ? `generate-video-part-${segment.part}` : "generate-video"
  }));

  if (source.complete.length > 1) {
    const size = source.complete.reduce((total, segment) => total + segment.size, 0);
    entries.push({
      id: "video-all",
      label: t("itemDownloadVideoAll", { count: source.complete.length }),
      detail: i18n.formatByteSize(size),
      disabled: false,
      segments: source.complete,
      icon: Files,
      testId: "generate-video-all"
    });
  }

  return entries;
}

let saving = false;

/**
 * Saves the segments one file each (sequentially, so memory holds one video at a time), with a
 * "preparing" notice that turns into "saved" or into the reason it failed (missing chunks).
 * A request while another is running is ignored.
 */
export async function saveVideos(
  archive: LoadedArchive,
  segments: readonly ScreenRecordingSegment[],
  locale: PlayerLocale,
  save?: (fileName: string, blob: Blob) => void
): Promise<VideoDownloadResult[]> {
  if (saving || segments.length === 0) {
    return [];
  }

  saving = true;
  const t: GenerateTranslate = (key, values) => generateMessages.translate(locale, key, values);
  const notice = toastManager.add({ title: t("videoPreparing"), timeout: 0 });
  const results: VideoDownloadResult[] = [];

  try {
    for (const segment of segments) {
      results.push(await downloadVideoSegment(archive, segment, save));
    }

    const asRecorded = results.some((result) => !result.video.seekable);
    const names = results.map((result) => result.fileName);
    toastManager.close(notice);
    toastManager.add({
      title:
        results.length === 1
          ? t("videoSaved", { fileName: names[0] ?? "" })
          : t("videoSavedParts", { count: results.length }),
      description: asRecorded
        ? t("videoAsRecorded")
        : results.length > 1
          ? names.join(", ")
          : undefined
    });
  } catch (error: unknown) {
    const missing = describeMissingChunks(error);
    toastManager.close(notice);
    toastManager.add({
      title: t("videoFailed"),
      description: missing
        ? t("videoMissingChunks", missing)
        : error instanceof Error
          ? error.message
          : String(error)
    });
  } finally {
    saving = false;
  }

  return results;
}

function EntryText({ entry }: { entry: VideoEntry }) {
  return (
    <span className="video-entry">
      <span>{entry.label}</span>
      <span className="video-entry-detail" data-testid={`${entry.testId}-detail`}>
        {entry.detail}
      </span>
    </span>
  );
}

type VideoMenuItemsProps = { archive: LoadedArchive };

/** The video section of a Base UI menu (the Generate menu and the transport's parts menu). */
export function VideoMenuItems({ archive }: VideoMenuItemsProps) {
  const t = useFeatureI18n(generateMessages);
  const i18n = useI18n();

  return (
    <>
      <div className="menu-note">{t("videoNote")}</div>
      {buildVideoEntries(archive, t, i18n).map((entry) => {
        const Glyph = entry.icon;

        return (
          <Menu.Item
            key={entry.id}
            className="menu-item"
            disabled={entry.disabled}
            onClick={() => void saveVideos(archive, entry.segments, i18n.locale)}
            data-testid={entry.testId}
          >
            <Glyph {...ICON_PROPS} />
            <EntryText entry={entry} />
          </Menu.Item>
        );
      })}
    </>
  );
}

/**
 * The transport's "download the tab video" button, only when the archive has a video: one
 * segment downloads at once, several open a menu of parts. Memoized: the transport re-renders on
 * every playhead tick, this button only when the archive or the language changes.
 */
export const VideoTransportButton = memo(function VideoTransportButton() {
  const t = useFeatureI18n(generateMessages);
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);

  if (!archive || videoSourceOf(archive).segments.length === 0) {
    return null;
  }

  const entries = buildVideoEntries(archive, t, i18n);
  const [only] = entries;

  if (entries.length === 1 && only) {
    return (
      <Hint label={`${t("videoButton")} · ${only.detail}`} side="top">
        <button
          type="button"
          className="btn icon-only"
          aria-label={`${t("videoButton")}, ${only.detail}`}
          aria-disabled={only.disabled || undefined}
          onClick={() => {
            if (!only.disabled) {
              void saveVideos(archive, only.segments, i18n.locale);
            }
          }}
          data-testid="transport-video"
        >
          <Download {...ICON_PROPS} />
        </button>
      </Hint>
    );
  }

  return (
    <Menu.Root>
      <Hint label={t("videoButton")} side="top">
        <Menu.Trigger
          className="btn icon-only"
          aria-label={t("videoButton")}
          data-testid="transport-video"
        >
          <Download {...ICON_PROPS} />
        </Menu.Trigger>
      </Hint>
      <Menu.Portal>
        <Menu.Positioner side="top" sideOffset={6} align="end" className="menu-layer">
          <Menu.Popup className="menu" data-testid="transport-video-menu">
            <VideoMenuItems archive={archive} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
});
