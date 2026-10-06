import { lowerBoundByMono, upperBoundByMono } from "../lib/range.js";
import type {
  PointerSample,
  ScreenRecordingRecord,
  ScreenshotMarker,
  ScreenshotRecord,
  ScreenshotTrailPoint
} from "./archive-model.js";

/** How far back the pointer trail on the stage reaches. */
export const TRAIL_WINDOW_MS = 3_500;
/** Most trail points drawn; longer trails are thinned evenly. */
export const MAX_TRAIL_POINTS = 110;

export function buildScreenshotTrail(
  points: PointerSample[],
  playheadMono: number
): ScreenshotTrailPoint[] {
  if (points.length === 0) {
    return [];
  }

  const startMono = playheadMono - TRAIL_WINDOW_MS;
  const startIndex = lowerBoundByMono(points, startMono, (point) => point.mono);
  const endIndex = upperBoundByMono(points, playheadMono, (point) => point.mono);
  const scoped = points.slice(startIndex, endIndex);

  if (scoped.length === 0) {
    return [];
  }

  const mapped = scoped.map((point) => ({
    x: point.x,
    y: point.y,
    mono: point.mono,
    click: point.click
  }));

  if (mapped.length <= MAX_TRAIL_POINTS) {
    return mapped;
  }

  const step = Math.ceil(mapped.length / MAX_TRAIL_POINTS);

  return mapped.filter((_, index) => index % step === 0 || index === mapped.length - 1);
}

export function resolveScreenshotMarker(
  points: PointerSample[],
  playheadMono: number,
  fallback: ScreenshotMarker | null
): ScreenshotMarker | null {
  const index = upperBoundByMono(points, playheadMono, (point) => point.mono) - 1;
  const latest = index >= 0 ? points[index] : undefined;

  if (latest) {
    return {
      x: latest.x,
      y: latest.y,
      reason: latest.reason,
      ...(latest.viewportWidth !== undefined && latest.viewportHeight !== undefined
        ? { viewportWidth: latest.viewportWidth, viewportHeight: latest.viewportHeight }
        : {})
    };
  }

  return fallback
    ? {
        ...fallback
      }
    : null;
}

export function resolveShotForMono(
  screenshots: ScreenshotRecord[],
  mono: number
): ScreenshotRecord | null {
  if (screenshots.length === 0) {
    return null;
  }

  const end = upperBoundByMono(screenshots, mono, (entry) => entry.mono) - 1;

  if (end < 0) {
    return null;
  }

  return screenshots[end] ?? null;
}

export function resolveScreenRecordingForMono(
  recordings: ScreenRecordingRecord[],
  mono: number
): ScreenRecordingRecord | null {
  if (recordings.length === 0) {
    return null;
  }

  const end = upperBoundByMono(recordings, mono, (entry) => entry.startMono) - 1;

  if (end < 0) {
    return null;
  }

  const recording = recordings[end] ?? null;

  if (!recording) {
    return null;
  }

  return mono <= recording.endMono + 1 ? recording : null;
}
