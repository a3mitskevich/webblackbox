import type { PlayerRange } from "@webblackbox/player-sdk";

import { formatClock } from "../../../core/format.js";
import type { TimeRange } from "../../../core/time-range.js";
import type { GenerateRequest } from "./api.js";

/**
 * The range a generator works on: the request's own range when it names one (`null` = the whole
 * session), else the timeline range, else the whole session.
 */
export function resolveGenerateRange(
  request: Pick<GenerateRequest, "range">,
  timelineRange: TimeRange | null
): TimeRange | null {
  return request.range === undefined ? timelineRange : request.range;
}

/** The player-sdk form of a range; `undefined` (no filter) for the whole session. */
export function toPlayerRange(range: TimeRange | null | undefined): PlayerRange | undefined {
  return range ? { monoStart: range.startMono, monoEnd: range.endMono } : undefined;
}

/** "0:09.45 – 0:12.10" relative to the session start; `null` for the whole session. */
export function formatRangeLabel(
  range: TimeRange | null,
  minMono: number,
  locale: string
): string | null {
  if (!range) {
    return null;
  }

  const start = formatClock(range.startMono - minMono, locale);
  const end = formatClock(range.endMono - minMono, locale);
  return `${start} – ${end}`;
}

/** The classic Playwright dialog's action cap: 1…500, 40 by default. */
export const DEFAULT_MAX_ACTIONS = 40;
export const MAX_ACTIONS_LIMIT = 500;

export function clampMaxActions(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_ACTIONS_LIMIT, Math.round(value)))
    : DEFAULT_MAX_ACTIONS;
}
