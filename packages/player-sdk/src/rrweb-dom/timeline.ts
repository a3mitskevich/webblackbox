import {
  isRrwebEventBatchPayload,
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  RRWEB_MOUSE_INTERACTIONS,
  type RrwebRecordedEvent,
  type RrwebRecorderState,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

import { asRecord, isNodeId } from "./serialized.js";

/** One rrweb event placed on the archive's clock. */
export type RrwebTimelineEntry = {
  /** Archive monotonic time: the batch's `mono` plus the event's offset in the batch. */
  mono: number;
  event: RrwebRecordedEvent;
  /** The `dom.rrweb.event` that carried it. */
  batchEventId: string;
};

export type RrwebStateEntry = {
  mono: number;
  state: RrwebRecorderState;
  batchEventId: string;
};

export type RrwebClickKind = "click" | "dblclick" | "contextmenu";

export type RrwebClick = {
  mono: number;
  nodeId: number;
  kind: RrwebClickKind;
  x?: number;
  y?: number;
  batchEventId: string;
};

export type RrwebInput = { mono: number; nodeId: number; batchEventId: string };

export type RrwebTimeline = {
  entries: readonly RrwebTimelineEntry[];
  /** Indexes into `entries` of the full snapshots, in time order. */
  fullSnapshots: readonly number[];
  states: readonly RrwebStateEntry[];
  clicks: readonly RrwebClick[];
  inputs: readonly RrwebInput[];
};

const CLICK_KINDS: Readonly<Record<number, RrwebClickKind>> = {
  [RRWEB_MOUSE_INTERACTIONS.click]: "click",
  [RRWEB_MOUSE_INTERACTIONS.dblClick]: "dblclick",
  [RRWEB_MOUSE_INTERACTIONS.contextMenu]: "contextmenu"
};

/** The rrweb `IncrementalSource` of an event, or null. */
export function incrementalSource(event: RrwebRecordedEvent): number | null {
  if (event.type !== RRWEB_EVENT_TYPES.incrementalSnapshot) {
    return null;
  }

  const source = asRecord(event.data)?.source;
  return typeof source === "number" ? source : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Every rrweb event of an archive (`dom.rrweb.event` with `schema: "rrweb/v2"`) on the archive's
 * clock, plus the full snapshots, recorder states (pressure gaps), clicks and field inputs. The
 * agent's older `rrweb-lite/v1` summaries are not rrweb events and are skipped.
 */
export function buildRrwebTimeline(events: readonly WebBlackboxEvent[]): RrwebTimeline {
  const batches = events
    .filter((event) => event.type === "dom.rrweb.event" && isRrwebEventBatchPayload(event.data))
    .slice()
    .sort((left, right) => left.mono - right.mono);
  const entries: RrwebTimelineEntry[] = [];
  const states: RrwebStateEntry[] = [];

  for (const batch of batches) {
    if (!isRrwebEventBatchPayload(batch.data)) {
      continue;
    }

    const first = batch.data.events[0]?.timestamp ?? 0;

    for (const event of batch.data.events) {
      entries.push({
        mono: batch.mono + Math.max(0, event.timestamp - first),
        event,
        batchEventId: batch.id
      });
    }

    if (batch.data.recorder) {
      const last = entries.at(-1);
      const mono =
        batch.data.recorder.status === "resumed" || !last || last.batchEventId !== batch.id
          ? batch.mono
          : last.mono;
      states.push({ mono, state: batch.data.recorder, batchEventId: batch.id });
    }
  }

  // Stable: events of one batch keep their order.
  entries.sort((left, right) => left.mono - right.mono);
  const fullSnapshots: number[] = [];
  const clicks: RrwebClick[] = [];
  const inputs: RrwebInput[] = [];

  entries.forEach((entry, index) => {
    if (entry.event.type === RRWEB_EVENT_TYPES.fullSnapshot) {
      fullSnapshots.push(index);
      return;
    }

    const source = incrementalSource(entry.event);
    const data = asRecord(entry.event.data);

    if (!data || !isNodeId(data.id)) {
      return;
    }

    if (source === RRWEB_INCREMENTAL_SOURCES.mouseInteraction) {
      const kind = typeof data.type === "number" ? CLICK_KINDS[data.type] : undefined;
      const x = finite(data.x);
      const y = finite(data.y);

      if (kind) {
        clicks.push({
          mono: entry.mono,
          nodeId: data.id,
          kind,
          ...(x === undefined ? {} : { x }),
          ...(y === undefined ? {} : { y }),
          batchEventId: entry.batchEventId
        });
      }
    } else if (source === RRWEB_INCREMENTAL_SOURCES.input) {
      inputs.push({ mono: entry.mono, nodeId: data.id, batchEventId: entry.batchEventId });
    }
  });

  return { entries, fullSnapshots, states, clicks, inputs };
}

/**
 * The pause or disable in force at `mono`, or null. A full snapshot after it (a resume, or a new
 * page whose recorder started afresh) ends it.
 */
export function recorderStateAt(timeline: RrwebTimeline, mono: number): RrwebStateEntry | null {
  let current: RrwebStateEntry | null = null;

  for (const entry of timeline.states) {
    if (entry.mono > mono) {
      break;
    }

    current = entry;
  }

  if (!current || current.state.status === "resumed") {
    return null;
  }

  const since = current.mono;
  const resumed = timeline.fullSnapshots.some((index) => {
    const snapshotMono = timeline.entries[index]?.mono ?? Number.NaN;
    return snapshotMono > since && snapshotMono <= mono;
  });
  return resumed ? null : current;
}
