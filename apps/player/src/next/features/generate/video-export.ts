import {
  ScreenRecordingIncompleteError,
  type ScreenRecordingBlob,
  type ScreenRecordingSegment
} from "@webblackbox/player-sdk";

import { downloadBlob } from "../../../lib/export.js";
import type { LoadedArchive } from "../../state.js";

/** Why the archive offers no tab video. */
export type VideoUnavailableReason =
  { kind: "lite" } | { kind: "failed"; message: string } | { kind: "none" };

export type VideoSource = {
  /** Segments in start order (one per `recordingId`). */
  segments: readonly ScreenRecordingSegment[];
  /** Segments that can be assembled (no missing chunk). */
  complete: readonly ScreenRecordingSegment[];
  unavailable: VideoUnavailableReason | null;
};

const SID_SHORT_MAX = 10;
const SITE_MAX = 60;
const FALLBACK_SITE = "recording";

const sources = new WeakMap<LoadedArchive, VideoSource>();

/** The tab video of an archive (memoized per opened archive). */
export function videoSourceOf(archive: LoadedArchive): VideoSource {
  const cached = sources.get(archive);

  if (cached) {
    return cached;
  }

  const segments = archive.player.getScreenRecordings();
  const source: VideoSource = {
    segments,
    complete: segments.filter((segment) => segment.missingChunks.length === 0),
    unavailable: segments.length > 0 ? null : unavailableReason(archive)
  };
  sources.set(archive, source);
  return source;
}

function unavailableReason(archive: LoadedArchive): VideoUnavailableReason {
  if (archive.view.meta.mode === "lite") {
    return { kind: "lite" };
  }

  const error = archive.model.events.find((event) => event.type === "screen.recording.error");
  const message = (error?.data as { message?: unknown } | undefined)?.message;

  return typeof message === "string" && message.length > 0
    ? { kind: "failed", message }
    : { kind: "none" };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `2026-10-06_10-38` in the viewer's time zone. */
function formatFileTime(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

/** The host of the recorded site only: paths and query strings can carry tokens. */
function siteSlug(origin: string): string {
  let host = "";

  try {
    host = new URL(origin).hostname;
  } catch {
    host = "";
  }

  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, SITE_MAX);
  return slug || FALLBACK_SITE;
}

/** `S-1791272280913-xg4fox03j9` → `xg4fox03j9`. */
function sidShort(sid: string): string {
  const tail = sid.split("-").filter(Boolean).at(-1) ?? "";
  return tail
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, SID_SHORT_MAX)
    .toLowerCase();
}

/**
 * `<site>-<YYYY-MM-DD_HH-mm>-<sid short>[-partN].webm`: the session's host, its start time and the
 * short session id; `part` only when the session has several video segments.
 */
export function videoFileName(archive: LoadedArchive, part: number | null): string {
  const firstEvent = archive.model.events[0];
  const startedAt = firstEvent?.t ?? Date.parse(archive.view.meta.createdAt);
  const pieces = [
    siteSlug(archive.view.meta.origin),
    Number.isFinite(startedAt) ? formatFileTime(startedAt) : null,
    firstEvent ? sidShort(firstEvent.sid) : null,
    part === null ? null : `part${part}`
  ].filter((piece): piece is string => Boolean(piece));

  return `${pieces.join("-")}.webm`;
}

export type VideoDownloadResult = { fileName: string; video: ScreenRecordingBlob };

/**
 * Assembles a segment's video and hands it to the browser as a file (a Blob URL revoked
 * afterwards). Throws the SDK's {@link ScreenRecordingIncompleteError} for missing chunks.
 */
export async function downloadVideoSegment(
  archive: LoadedArchive,
  segment: ScreenRecordingSegment,
  save: (fileName: string, blob: Blob) => void = downloadBlob
): Promise<VideoDownloadResult> {
  const multiple = videoSourceOf(archive).segments.length > 1;
  const video = await archive.player.getScreenRecordingBlob(segment.recordingId);
  const fileName = videoFileName(archive, multiple ? segment.part : null);
  const mime = video.mime.split(";")[0]?.trim() || "video/webm";
  // The SDK hands over a fresh ArrayBuffer-backed array: no need to copy a large video again.
  const bytes =
    video.bytes.buffer instanceof ArrayBuffer
      ? (video.bytes as Uint8Array<ArrayBuffer>)
      : video.bytes.slice();
  save(fileName, new Blob([bytes], { type: mime }));
  return { fileName, video };
}

/** The chunks an incomplete recording lacks, numbered for people (`4, 8` of 20). */
export function describeMissingChunks(error: unknown): { chunks: string; total: number } | null {
  if (!(error instanceof ScreenRecordingIncompleteError)) {
    return null;
  }

  return {
    chunks: error.missing.map((entry) => String(entry.index + 1)).join(", "),
    total: error.chunkCount
  };
}
