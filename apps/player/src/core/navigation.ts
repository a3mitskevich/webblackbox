import { lowerBoundByMono, upperBoundByMono } from "../lib/range.js";

/** What the single player-wide selection points at (PROPOSAL §3: one selection, time + object). */
export type SelectionKind = "event" | "request" | "action";

export type Selection = {
  kind: SelectionKind;
  id: string;
};

export type Direction = 1 | -1;

/** Items closer than this to the playhead count as "at" the playhead, not before/after it. */
const SAME_TIME_EPSILON_MS = 0.5;

export function isSameSelection(left: Selection | null, right: Selection | null): boolean {
  return left?.kind === right?.kind && left?.id === right?.id;
}

/**
 * The first item strictly after (`direction` 1) or before (-1) `mono` that passes `accept`, in a
 * list sorted by mono.
 */
export function findByTime<T>(
  items: readonly T[],
  pickMono: (item: T) => number,
  mono: number,
  direction: Direction,
  accept: (item: T) => boolean = () => true
): T | null {
  const list = items as T[];

  if (direction === 1) {
    for (
      let index = upperBoundByMono(list, mono + SAME_TIME_EPSILON_MS, pickMono);
      index < list.length;
      index += 1
    ) {
      const item = list[index];

      if (item !== undefined && accept(item)) {
        return item;
      }
    }

    return null;
  }

  for (
    let index = lowerBoundByMono(list, mono - SAME_TIME_EPSILON_MS, pickMono) - 1;
    index >= 0;
    index -= 1
  ) {
    const item = list[index];

    if (item !== undefined && accept(item)) {
      return item;
    }
  }

  return null;
}

/**
 * J / L: the neighbour of the selected item in the current list, or — when nothing in the list is
 * selected — the first item after (or before) the playhead.
 */
export function stepInList<T>(
  items: readonly T[],
  options: {
    pickId: (item: T) => string;
    pickMono: (item: T) => number;
    selectedId: string | null;
    playheadMono: number;
    direction: Direction;
  }
): T | null {
  const selectedIndex =
    options.selectedId === null
      ? -1
      : items.findIndex((item) => options.pickId(item) === options.selectedId);

  if (selectedIndex >= 0) {
    return items[selectedIndex + options.direction] ?? null;
  }

  return findByTime(items, options.pickMono, options.playheadMono, options.direction);
}
