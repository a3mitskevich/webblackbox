/**
 * A selected stretch of the recording (PROPOSAL §4: dragging on the timeline selects a range; the
 * range frames the Playwright test and the bug report). Both ends are monotonic times.
 */
export type TimeRange = {
  startMono: number;
  endMono: number;
};

/** Ranges shorter than this are a click, not a selection. */
export const MIN_RANGE_MS = 50;

/**
 * Orders the ends and clamps them into `bounds`; `null` when the result is shorter than
 * `MIN_RANGE_MS` (a click or a drag that left the recording).
 */
export function normalizeRange(
  a: number,
  b: number,
  bounds: { minMono: number; maxMono: number }
): TimeRange | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }

  const startMono = Math.max(bounds.minMono, Math.min(a, b));
  const endMono = Math.min(bounds.maxMono, Math.max(a, b));
  return endMono - startMono >= MIN_RANGE_MS ? { startMono, endMono } : null;
}

/** Whether `mono` lies in the range (both ends included); everything is in a missing range. */
export function isInRange(range: TimeRange | null, mono: number): boolean {
  return range === null || (mono >= range.startMono && mono <= range.endMono);
}

/**
 * `[` / `]`: moves one end of the range to the playhead. Without a range, `[` starts one that runs
 * to the end of the recording and `]` one that runs from its start. An end that would cross the
 * other one swaps them. A move that would leave less than `MIN_RANGE_MS` keeps the range as it was
 * (an edge key never clears a selection).
 */
export function moveRangeEdge(
  range: TimeRange | null,
  edge: "start" | "end",
  mono: number,
  bounds: { minMono: number; maxMono: number }
): TimeRange | null {
  const current = range ?? { startMono: bounds.minMono, endMono: bounds.maxMono };
  const moved =
    edge === "start"
      ? normalizeRange(mono, current.endMono, bounds)
      : normalizeRange(current.startMono, mono, bounds);
  return moved ?? range;
}

export function isSameRange(left: TimeRange | null, right: TimeRange | null): boolean {
  return left?.startMono === right?.startMono && left?.endMono === right?.endMono;
}
