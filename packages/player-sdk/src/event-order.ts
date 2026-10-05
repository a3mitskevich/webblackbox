import type { WebBlackboxEvent } from "@webblackbox/protocol";

type TimelineOrderedEvent = Pick<WebBlackboxEvent, "mono" | "t" | "id">;

/**
 * Timeline order used everywhere events are exposed: monotonic time first, then wall-clock time,
 * then event id (by code point, so the order does not depend on the runtime locale).
 *
 * Archives store events in arrival order, which is not `mono` order: page-side events reach the
 * recorder later than CDP events of the same moment and can land in a later chunk.
 */
export function compareEventsForTimeline(
  left: TimelineOrderedEvent,
  right: TimelineOrderedEvent
): number {
  const byMono = left.mono - right.mono;

  if (byMono !== 0 && !Number.isNaN(byMono)) {
    return byMono;
  }

  const byWallTime = left.t - right.t;

  if (byWallTime !== 0 && !Number.isNaN(byWallTime)) {
    return byWallTime;
  }

  if (left.id === right.id) {
    return 0;
  }

  return left.id < right.id ? -1 : 1;
}

/** Returns `events` itself when already in timeline order, otherwise a sorted copy. */
export function sortEventsForTimeline<TEvent extends TimelineOrderedEvent>(
  events: TEvent[]
): TEvent[] {
  return isInTimelineOrder(events) ? events : [...events].sort(compareEventsForTimeline);
}

/**
 * Merges lists that are each in timeline order into one ordered list without re-sorting.
 * Lists that follow each other without overlap are concatenated; overlapping ones are merged
 * pairwise (O(n log k)). A single non-empty list is returned as is.
 */
export function mergeSortedEventLists<TEvent extends TimelineOrderedEvent>(
  lists: TEvent[][]
): TEvent[] {
  const nonEmpty = lists.filter((list) => list.length > 0);

  if (nonEmpty.length === 0) {
    return [];
  }

  if (nonEmpty.length === 1) {
    return nonEmpty[0] ?? [];
  }

  if (areSequential(nonEmpty)) {
    return nonEmpty.flat() as TEvent[];
  }

  let pending = nonEmpty;

  while (pending.length > 1) {
    const next: TEvent[][] = [];

    for (let index = 0; index < pending.length; index += 2) {
      const left = pending[index] ?? [];
      const right = pending[index + 1];
      next.push(right ? mergeTwo(left, right) : left);
    }

    pending = next;
  }

  return pending[0] ?? [];
}

/** Index of the first event with `mono >= mono` in a timeline-ordered list. */
export function lowerBoundEventMono(
  events: Pick<WebBlackboxEvent, "mono">[],
  mono: number
): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if ((events[mid]?.mono ?? Number.POSITIVE_INFINITY) < mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/** Index of the first event with `mono > mono` in a timeline-ordered list. */
export function upperBoundEventMono(
  events: Pick<WebBlackboxEvent, "mono">[],
  mono: number
): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if ((events[mid]?.mono ?? Number.POSITIVE_INFINITY) <= mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function isInTimelineOrder(events: TimelineOrderedEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];

    if (previous && current && compareEventsForTimeline(previous, current) > 0) {
      return false;
    }
  }

  return true;
}

function areSequential(lists: TimelineOrderedEvent[][]): boolean {
  for (let index = 1; index < lists.length; index += 1) {
    const previousTail = lists[index - 1]?.at(-1);
    const currentHead = lists[index]?.[0];

    if (previousTail && currentHead && compareEventsForTimeline(previousTail, currentHead) > 0) {
      return false;
    }
  }

  return true;
}

function mergeTwo<TEvent extends TimelineOrderedEvent>(left: TEvent[], right: TEvent[]): TEvent[] {
  const merged: TEvent[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftEvent = left[leftIndex] as TEvent;
    const rightEvent = right[rightIndex] as TEvent;

    if (compareEventsForTimeline(leftEvent, rightEvent) <= 0) {
      merged.push(leftEvent);
      leftIndex += 1;
    } else {
      merged.push(rightEvent);
      rightIndex += 1;
    }
  }

  for (; leftIndex < left.length; leftIndex += 1) {
    merged.push(left[leftIndex] as TEvent);
  }

  for (; rightIndex < right.length; rightIndex += 1) {
    merged.push(right[rightIndex] as TEvent);
  }

  return merged;
}
