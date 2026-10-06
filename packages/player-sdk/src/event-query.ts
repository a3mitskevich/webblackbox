import type { WebBlackboxEvent } from "@webblackbox/protocol";

import type { ChunkMonoBounds } from "./archive-reader.js";
import { lowerBoundEventMono, upperBoundEventMono } from "./event-order.js";
import type { PlayerRange } from "./types.js";

export function isErrorEvent(event: WebBlackboxEvent): boolean {
  return event.type.startsWith("error.") || event.lvl === "error";
}

export function sliceEventsByMonoRange(
  events: WebBlackboxEvent[],
  range?: PlayerRange
): WebBlackboxEvent[] {
  if (isRangeUnbounded(range)) {
    return events;
  }

  const start = range?.monoStart === undefined ? 0 : lowerBoundEventMono(events, range.monoStart);
  const end =
    range?.monoEnd === undefined ? events.length : upperBoundEventMono(events, range.monoEnd);

  return events.slice(start, end);
}

export function chunkSourceIntersectsRange(chunk: ChunkMonoBounds, range: PlayerRange): boolean {
  if (
    Number.isFinite(chunk.monoEnd) &&
    range.monoStart !== undefined &&
    chunk.monoEnd < range.monoStart
  ) {
    return false;
  }

  if (
    Number.isFinite(chunk.monoStart) &&
    range.monoEnd !== undefined &&
    chunk.monoStart > range.monoEnd
  ) {
    return false;
  }

  return true;
}

export function withinRange(event: WebBlackboxEvent, range?: PlayerRange): boolean {
  if (!range) {
    return true;
  }

  if (range.monoStart !== undefined && event.mono < range.monoStart) {
    return false;
  }

  if (range.monoEnd !== undefined && event.mono > range.monoEnd) {
    return false;
  }

  return true;
}

export function isRangeUnbounded(range?: PlayerRange): boolean {
  return !range || (range.monoStart === undefined && range.monoEnd === undefined);
}

export function matchesText(event: WebBlackboxEvent, term: string): boolean {
  if (event.type.toLowerCase().includes(term)) {
    return true;
  }

  if (event.id.toLowerCase().includes(term)) {
    return true;
  }

  return JSON.stringify(event.data).toLowerCase().includes(term);
}

export function collectInvertedCandidateIds(
  inverted: Map<string, string[]>,
  query: string
): Set<string> | null {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  const tokens = normalized
    .split(/[^a-zA-Z0-9_:.\-/]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  // A token missing from the index may have been left out as too frequent (the pipeline bounds
  // the index), so the other tokens' postings would miss events that hold it: scan every event.
  if (tokens.some((token) => !inverted.has(token))) {
    return null;
  }

  const keys = new Set<string>([normalized, ...tokens]);
  const output = new Set<string>();

  for (const key of keys) {
    const eventIds = inverted.get(key);

    if (!eventIds) {
      continue;
    }

    for (const eventId of eventIds) {
      output.add(eventId);
    }
  }

  return output.size > 0 ? output : null;
}

export function intersectCandidateIds(
  left: Set<string> | null,
  right: Set<string> | null
): Set<string> | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  const intersection = new Set<string>();

  for (const value of smaller) {
    if (larger.has(value)) {
      intersection.add(value);
    }
  }

  return intersection;
}

export function computeTextScore(event: WebBlackboxEvent, term: string): number {
  let score = 0;

  if (event.type.toLowerCase().includes(term)) {
    score += 6;
  }

  if (event.id.toLowerCase().includes(term)) {
    score += 4;
  }

  const payload = JSON.stringify(event.data).toLowerCase();

  if (payload.includes(term)) {
    score += 2;
  }

  return score;
}
