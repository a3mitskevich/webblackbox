import { isProblemEvent } from "@webblackbox/player-sdk";

import type { ArchiveModel } from "./archive-model.js";
import { buildLaneTicks, ratioOf, type TimelineWindow } from "./timeline-lanes.js";
import type { PointerLaneMark } from "../lib/pointer-overlay.js";
import { isTabLifecycleEvent } from "../lib/tabs-context-view.js";

/** At most this many screenshot buttons on the filmstrip lane; denser sessions keep one per slot. */
export const FILMSTRIP_MAX_FRAMES = 120;

const NAVIGATION_TYPES = new Set([
  "nav.commit",
  "nav.reload",
  "nav.hash",
  "nav.history.push",
  "nav.history.replace"
]);

export type LaneEventMark = {
  ratio: number;
  mono: number;
  eventId: string;
};

export type FilmstripFrame = LaneEventMark & {
  shotId: string;
};

export type RecordingSpan = {
  recordingId: string;
  startRatio: number;
  endRatio: number;
};

/**
 * The lanes "Expand lanes" adds (PROPOSAL §10, borrowed from Bench): navigation, console,
 * storage, pointer (clicks, rage and dead clicks), the screenshot filmstrip, recordings and tabs.
 * Tick lanes are positions (0…1) for drawing; the marks keep their event for click-to-select.
 */
export type ExpandedLanes = {
  navigation: LaneEventMark[];
  console: { ticks: number[]; errorTicks: number[]; marks: LaneEventMark[] };
  storage: LaneEventMark[];
  pointer: (PointerLaneMark & { ratio: number })[];
  filmstrip: FilmstripFrame[];
  recordings: RecordingSpan[];
  tabs: LaneEventMark[];
};

function mark(window: TimelineWindow, mono: number, eventId: string): LaneEventMark {
  return { ratio: ratioOf(mono, window), mono, eventId };
}

/**
 * Splits the track into `max` equal slots and keeps one item per slot (items sorted by mono): the
 * first one, or the highest `rank` when given.
 */
export function thinBySlot<T extends { ratio: number }>(
  items: readonly T[],
  max: number,
  rank?: (item: T) => number
): T[] {
  if (items.length <= max) {
    return [...items];
  }

  const slots = new Map<number, T>();

  for (const item of items) {
    const slot = Math.min(max - 1, Math.floor(item.ratio * max));
    const kept = slots.get(slot);

    if (!kept || (rank && rank(item) > rank(kept))) {
      slots.set(slot, item);
    }
  }

  return [...slots.values()];
}

export function buildExpandedLanes(model: ArchiveModel, window: TimelineWindow): ExpandedLanes {
  const navigation: LaneEventMark[] = [];
  const tabs: LaneEventMark[] = [];

  for (const event of model.events) {
    if (NAVIGATION_TYPES.has(event.type)) {
      navigation.push(mark(window, event.mono, event.id));
    } else if (event.type === "meta.tabs.snapshot" || isTabLifecycleEvent(event)) {
      tabs.push(mark(window, event.mono, event.id));
    }
  }

  const consoleMarks = model.consoleSignals.map((event) => mark(window, event.mono, event.id));
  const consoleErrors = model.consoleSignals.filter(isProblemEvent).map((event) => event.mono);

  return {
    navigation,
    console: {
      ticks: buildLaneTicks(
        model.consoleSignals.filter((event) => !isProblemEvent(event)).map((event) => event.mono),
        window
      ),
      errorTicks: buildLaneTicks(consoleErrors, window),
      marks: consoleMarks
    },
    storage: model.storage.map((entry) => mark(window, entry.mono, entry.eventId)),
    pointer: model.pointerLane.map((entry) => ({ ...entry, ratio: ratioOf(entry.mono, window) })),
    filmstrip: thinBySlot(
      model.screenshots.map((shot) => ({
        ...mark(window, shot.mono, shot.eventId),
        shotId: shot.shotId
      })),
      FILMSTRIP_MAX_FRAMES
    ),
    recordings: model.screenRecordings.map((recording) => ({
      recordingId: recording.recordingId,
      startRatio: ratioOf(recording.startMono, window),
      endRatio: ratioOf(recording.endMono, window)
    })),
    tabs
  };
}
