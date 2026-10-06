const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;

const formatters = new Map<string, Intl.NumberFormat>();

function getFormatter(locale: string, key: string, options: Intl.NumberFormatOptions) {
  const cacheKey = `${locale}|${key}`;
  let formatter = formatters.get(cacheKey);

  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatters.set(cacheKey, formatter);
  }

  return formatter;
}

function finiteNonNegative(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Transport clock `m:ss.cc` with the locale's decimal separator: `0:10.89`, `0:10,89`.
 * Hundredths are truncated, so the clock never shows a time the playhead has not reached.
 */
export function formatClock(ms: number, locale: string): string {
  const centiseconds = Math.floor(finiteNonNegative(ms) / 10);
  const minutes = Math.floor(centiseconds / (SECONDS_PER_MINUTE * 100));
  const seconds = (centiseconds - minutes * SECONDS_PER_MINUTE * 100) / 100;
  const secondsText = getFormatter(locale, "clock", {
    minimumIntegerDigits: 2,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }).format(seconds);

  return `${minutes}:${secondsText}`;
}

/** Offset column of the lists: seconds with two decimals, `10.89` / `10,89`. */
export function formatOffset(ms: number, locale: string): string {
  return getFormatter(locale, "offset", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  }).format(Math.floor(finiteNonNegative(ms) / 10) / 100);
}

/** Ruler ticks: whole seconds, or one decimal for the last (session length) tick. */
export function formatRulerSeconds(ms: number, locale: string, fractionDigits = 0): string {
  return getFormatter(locale, `ruler${fractionDigits}`, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: false
  }).format(finiteNonNegative(ms) / MS_PER_SECOND);
}

/** Evenly spaced "nice" ruler steps (1, 2, 3, 5, 10, 15, 30, 60 … seconds) for about `count` ticks. */
export function resolveRulerStepMs(durationMs: number, count = 6): number {
  const steps = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600];
  const target = finiteNonNegative(durationMs) / MS_PER_SECOND / Math.max(1, count);
  const step = steps.find((candidate) => candidate >= target) ?? steps[steps.length - 1] ?? 1;

  return step * MS_PER_SECOND;
}

/** Recording date for the session header, in the user's locale and time zone. */
export function formatRecordedAt(iso: string, locale: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
