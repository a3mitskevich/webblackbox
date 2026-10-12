import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";
import {
  isRrwebEventBatchPayload,
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  type RrwebRecordedEvent,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

/** rrweb `MouseInteractions` that are clicks: Click and DblClick. */
const CLICK_INTERACTIONS = new Set([2, 4]);
/** The highlight follows a click for this long after it (then the page has moved on). */
export const CLICK_HIGHLIGHT_WINDOW_MS = 1_500;
/** Response bodies the replay may use instead of the live URL (stylesheets, images, fonts). */
const RESOURCE_MIME_PATTERN = /^(text\/css|image\/|font\/|application\/(font-|x-font-))/i;
export const MAX_REPLAY_RESOURCES = 400;

/** The page time of a batch's first rrweb event, paired with its archive mono time. */
export type RrwebAnchor = { mono: number; timestamp: number };

export type RrwebClick = {
  timestamp: number;
  mono: number;
  nodeId: number;
  x: number | null;
  y: number | null;
};

export type RrwebTimeline = {
  tab: number;
  /** All rrweb events of the tab in timestamp order (what the Replayer gets). */
  events: RrwebRecordedEvent[];
  anchors: RrwebAnchor[];
  clicks: RrwebClick[];
  fullSnapshots: number;
  /** Tabs with an rrweb log that this timeline leaves out (one tab replays at a time). */
  otherTabs: number[];
};

type Batch = { event: WebBlackboxEvent; events: RrwebRecordedEvent[] };

function readBatches(events: readonly WebBlackboxEvent[]): Batch[] {
  return events.flatMap((event) =>
    event.type === "dom.rrweb.event" &&
    isRrwebEventBatchPayload(event.data) &&
    event.data.events.length > 0
      ? [{ event, events: event.data.events }]
      : []
  );
}

/** The tab with the most rrweb batches: one replay shows one page. */
function pickTab(batches: readonly Batch[]): { tab: number; otherTabs: number[] } {
  const counts = new Map<number, number>();

  for (const { event } of batches) {
    counts.set(event.tab, (counts.get(event.tab) ?? 0) + 1);
  }

  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  return { tab: ranked[0]![0], otherTabs: ranked.slice(1).map(([tab]) => tab) };
}

function lastAtOrBefore<T>(
  items: readonly T[],
  value: number,
  keyOf: (item: T) => number
): T | null {
  let low = 0;
  let high = items.length - 1;
  let found: T | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const item = items[middle]!;

    if (keyOf(item) <= value) {
      found = item;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

/** rrweb page time of an archive mono time, through the nearest batch at or before it. */
export function timestampAtMono(timeline: RrwebTimeline, mono: number): number {
  const anchor =
    lastAtOrBefore(timeline.anchors, mono, (item) => item.mono) ?? timeline.anchors[0]!;
  return mono + (anchor.timestamp - anchor.mono);
}

/** Archive mono time of an rrweb page time. */
export function monoAtTimestamp(timeline: RrwebTimeline, timestamp: number): number {
  const anchor =
    lastAtOrBefore(timeline.anchors, timestamp, (item) => item.timestamp) ?? timeline.anchors[0]!;
  return timestamp - (anchor.timestamp - anchor.mono);
}

function readClick(event: RrwebRecordedEvent): Omit<RrwebClick, "mono"> | null {
  if (event.type !== RRWEB_EVENT_TYPES.incrementalSnapshot) {
    return null;
  }

  const data = event.data as Record<string, unknown> | null;

  if (
    data?.source !== RRWEB_INCREMENTAL_SOURCES.mouseInteraction ||
    typeof data.type !== "number" ||
    !CLICK_INTERACTIONS.has(data.type) ||
    typeof data.id !== "number"
  ) {
    return null;
  }

  return {
    timestamp: event.timestamp,
    nodeId: data.id,
    x: typeof data.x === "number" ? data.x : null,
    y: typeof data.y === "number" ? data.y : null
  };
}

/** The rrweb log of the archive (the tab with most of it), or null when it has none. */
export function buildRrwebTimeline(events: readonly WebBlackboxEvent[]): RrwebTimeline | null {
  const allBatches = readBatches(events);

  if (allBatches.length === 0) {
    return null;
  }

  const { tab, otherTabs } = pickTab(allBatches);
  const batches = allBatches.filter((batch) => batch.event.tab === tab);
  const anchors = batches
    .map(({ event, events: batchEvents }) => ({
      mono: event.mono,
      timestamp: batchEvents[0]!.timestamp
    }))
    .sort((left, right) => left.mono - right.mono);
  const rrwebEvents = batches
    .flatMap((batch) => batch.events)
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.timestamp - right.event.timestamp || left.index - right.index)
    .map(({ event }) => event);
  const timeline: RrwebTimeline = {
    tab,
    events: rrwebEvents,
    anchors,
    clicks: [],
    fullSnapshots: rrwebEvents.filter((event) => event.type === RRWEB_EVENT_TYPES.fullSnapshot)
      .length,
    otherTabs
  };
  const clicks = rrwebEvents.flatMap((event) => {
    const click = readClick(event);
    return click ? [{ ...click, mono: monoAtTimestamp(timeline, click.timestamp) }] : [];
  });

  return { ...timeline, clicks };
}

/** The click the highlight shows at a page time: the last one shortly before it. */
export function clickAt(timeline: RrwebTimeline, timestamp: number): RrwebClick | null {
  const click = lastAtOrBefore(timeline.clicks, timestamp, (item) => item.timestamp);
  return click && timestamp - click.timestamp <= CLICK_HIGHLIGHT_WINDOW_MS ? click : null;
}

export type ReplayResourceRef = { url: string; mime: string; hash: string };

/** Stored stylesheet, image and font responses the replay can use offline (first per URL). */
export function selectReplayResources(
  entries: readonly NetworkWaterfallEntry[]
): ReplayResourceRef[] {
  const byUrl = new Map<string, ReplayResourceRef>();

  for (const entry of entries) {
    const mime = entry.mimeType ?? "";

    if (
      !entry.responseBodyHash ||
      entry.responseBodyTruncated === true ||
      !RESOURCE_MIME_PATTERN.test(mime) ||
      byUrl.has(entry.url)
    ) {
      continue;
    }

    byUrl.set(entry.url, { url: entry.url, mime, hash: entry.responseBodyHash });

    if (byUrl.size >= MAX_REPLAY_RESOURCES) {
      break;
    }
  }

  return [...byUrl.values()];
}
