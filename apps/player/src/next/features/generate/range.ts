import type { PlayerRange } from "@webblackbox/player-sdk";

import { formatClock } from "../../../core/format.js";
import { MIN_RANGE_MS, normalizeRange, type TimeRange } from "../../../core/time-range.js";
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

/** The From / To fields' text: seconds from the session start. */
export type RangeText = { from: string; to: string };

export type RangeField = keyof RangeText;

/** What committing the typed From / To does. */
export type TypedRangeResult =
  | { status: "unchanged" }
  | { status: "applied"; range: TimeRange | null }
  | { status: "invalid"; reason: "not-a-number" | "too-short"; fields: readonly RangeField[] };

type RangeBounds = { minMono: number; maxMono: number };

/** Seconds from the session start, as the range fields show them. */
export function toSecondsText(ms: number): string {
  return (Math.max(0, ms) / 1_000).toFixed(2);
}

/** The text the fields show for an applied range (`null` = the whole session). */
export function rangeText(range: TimeRange | null, bounds: RangeBounds): RangeText {
  return {
    from: toSecondsText((range?.startMono ?? bounds.minMono) - bounds.minMono),
    to: toSecondsText((range?.endMono ?? bounds.maxMono) - bounds.minMono)
  };
}

/** Typed seconds ("9.45" or "9,45"); `null` for an empty field or anything that is not a number. */
export function parseSeconds(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  const value = normalized ? Number(normalized) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * Commits the typed From / To against the applied `range`. Only a field whose text differs from
 * what was shown is read, so leaving an untouched field never moves the range by the shown
 * rounding; the other end keeps its exact time. A field that is not a number, or a range shorter
 * than `MIN_RANGE_MS`, is an error and the applied range stays. A range that covers the whole
 * recording is no range (the generators then see every event).
 */
export function commitTypedRange(
  typed: RangeText,
  range: TimeRange | null,
  bounds: RangeBounds
): TypedRangeResult {
  const shown = rangeText(range, bounds);
  const changed = (["from", "to"] as const).filter((field) => typed[field] !== shown[field]);

  if (changed.length === 0) {
    return { status: "unchanged" };
  }

  const seconds = {
    from: changed.includes("from") ? parseSeconds(typed.from) : null,
    to: changed.includes("to") ? parseSeconds(typed.to) : null
  };
  const notNumbers = changed.filter((field) => seconds[field] === null);

  if (notNumbers.length > 0) {
    return { status: "invalid", reason: "not-a-number", fields: notNumbers };
  }

  const { minMono, maxMono } = bounds;
  const next = normalizeRange(
    seconds.from === null ? (range?.startMono ?? minMono) : minMono + seconds.from * 1_000,
    seconds.to === null ? (range?.endMono ?? maxMono) : minMono + seconds.to * 1_000,
    bounds
  );

  if (!next) {
    return { status: "invalid", reason: "too-short", fields: changed };
  }

  const isWhole = next.startMono <= minMono && next.endMono >= maxMono - MIN_RANGE_MS;
  return { status: "applied", range: isWhole ? null : next };
}
