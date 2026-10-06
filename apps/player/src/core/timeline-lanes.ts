import type { RouteChapter, RouteChapterKind } from "@webblackbox/player-sdk";

import { lowerBoundByMono } from "../lib/range.js";

/** Bars of the network density lane. */
export const NETWORK_DENSITY_BINS = 72;
/** Chapters narrower than this share of the session are merged with their narrow neighbours. */
export const CHAPTER_MIN_SHARE = 0.06;
/** At most this many labels are joined into one merged chapter (`a → b → c …`). */
const CHAPTER_MAX_JOINED_LABELS = 3;
/** Prefix of reload chapters (language-neutral). */
export const RELOAD_MARK = "↻";
/** Ticks closer than this share of the session collapse into one. */
const TICK_MIN_SHARE = 0.002;

/** Timeline window: the normalized session bounds. */
export type TimelineWindow = {
  minMono: number;
  durationMono: number;
};

export type DensityBin = {
  count: number;
  /** At least one entry in the bin failed (4xx/5xx or network error). */
  failed: boolean;
};

export type TimelineChapter = {
  startMono: number;
  endMono: number;
  /** One route, or `a → b → c` for merged narrow chapters. */
  label: string;
  kind: RouteChapterKind;
  /** Navigation that started the (first) chapter. */
  eventId?: string;
  /** The route looks like an error page (`#/error`, `/500`). */
  isErrorRoute: boolean;
};

/** Position of `mono` on the timeline, clamped to 0…1. */
export function ratioOf(mono: number, window: TimelineWindow): number {
  if (window.durationMono <= 0 || !Number.isFinite(mono)) {
    return 0;
  }

  return Math.min(1, Math.max(0, (mono - window.minMono) / window.durationMono));
}

/** Requests per time bin, with the failed flag for the red bars. */
export function buildDensityBins(
  entries: readonly { startMono: number; failed: boolean }[],
  window: TimelineWindow,
  binCount: number = NETWORK_DENSITY_BINS
): DensityBin[] {
  const bins: DensityBin[] = Array.from({ length: binCount }, () => ({ count: 0, failed: false }));

  for (const entry of entries) {
    const index = Math.min(binCount - 1, Math.floor(ratioOf(entry.startMono, window) * binCount));
    const bin = bins[index];

    if (bin) {
      bins[index] = { count: bin.count + 1, failed: bin.failed || entry.failed };
    }
  }

  return bins;
}

/** Tick positions (0…1) for a lane; ticks closer than `TICK_MIN_SHARE` collapse into one. */
export function buildLaneTicks(monos: readonly number[], window: TimelineWindow): number[] {
  const ticks: number[] = [];

  for (const mono of [...monos].sort((left, right) => left - right)) {
    const ratio = ratioOf(mono, window);
    const last = ticks[ticks.length - 1];

    if (last === undefined || ratio - last >= TICK_MIN_SHARE) {
      ticks.push(ratio);
    }
  }

  return ticks;
}

/**
 * Chapters for the chapter strip: runs of chapters narrower than `minShare` are merged into one
 * segment labelled `a → b → c`, so short redirects stay visible without unreadable slivers.
 */
export function compactChapters(
  chapters: readonly RouteChapter[],
  window: TimelineWindow,
  minShare: number = CHAPTER_MIN_SHARE
): TimelineChapter[] {
  const minWidth = window.durationMono * minShare;
  const result: TimelineChapter[] = [];
  let run: RouteChapter[] = [];

  const flush = (): void => {
    const first = run[0];
    const last = run[run.length - 1];

    if (!first || !last) {
      return;
    }

    const labels = run.map((chapter) =>
      chapter.kind === "reload" ? `${RELOAD_MARK} ${chapter.label}` : chapter.label
    );
    const joined = labels.slice(0, CHAPTER_MAX_JOINED_LABELS).join(" → ");

    result.push({
      startMono: first.startMono,
      endMono: last.endMono,
      label: labels.length > CHAPTER_MAX_JOINED_LABELS ? `${joined} …` : joined,
      kind: first.kind,
      ...(first.eventId ? { eventId: first.eventId } : {}),
      isErrorRoute: labels.some(isErrorRouteLabel)
    });
    run = [];
  };

  for (const chapter of chapters) {
    const narrow = chapter.endMono - chapter.startMono < minWidth;

    if (!narrow) {
      flush();
      run = [chapter];
      flush();
      continue;
    }

    run.push(chapter);
  }

  flush();
  return result;
}

/** `#/error`, `/error/500`, `/404`… */
export function isErrorRouteLabel(label: string): boolean {
  return /error|\/(?:4\d\d|5\d\d)(?:\/|$)/i.test(label);
}

/** The item nearest to `mono` in a list sorted by mono. */
export function findNearest<T>(
  items: readonly T[],
  pickMono: (item: T) => number,
  mono: number
): T | null {
  const index = lowerBoundByMono(items as T[], mono, pickMono);
  const after = items[index];
  const before = items[index - 1];

  if (after === undefined) {
    return before ?? null;
  }

  if (before === undefined) {
    return after;
  }

  return mono - pickMono(before) <= pickMono(after) - mono ? before : after;
}
