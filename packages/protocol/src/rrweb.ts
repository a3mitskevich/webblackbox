/**
 * Real rrweb 2.x events inside `dom.rrweb.event`. The page batches the events rrweb emits and
 * records one `dom.rrweb.event` per batch; the older `rrweb-lite/v1` payloads (mutation summaries
 * of the agent's own DOM capture) keep their own schema tag.
 */
export const RRWEB_EVENT_SCHEMA = "rrweb/v2";

/** Raw content event type of an rrweb batch (the legacy `rrweb` raw type is a summary). */
export const RRWEB_RAW_TYPE = "rrwebRecord";

/** rrweb `EventType` values the WebBlackbox code reads. */
export const RRWEB_EVENT_TYPES = {
  fullSnapshot: 2,
  incrementalSnapshot: 3,
  meta: 4
} as const;

/** rrweb `IncrementalSource` values the WebBlackbox code reads. */
export const RRWEB_INCREMENTAL_SOURCES = {
  mutation: 0,
  mouseMove: 1,
  mouseInteraction: 2,
  scroll: 3,
  input: 5
} as const;

/** rrweb `MouseInteractions` values the WebBlackbox code reads. */
export const RRWEB_MOUSE_INTERACTIONS = {
  click: 2,
  contextMenu: 3,
  dblClick: 4
} as const;

/** One rrweb event as recorded (`eventWithTime`); `data` stays rrweb's own shape. */
export type RrwebRecordedEvent = {
  type: number;
  timestamp: number;
  data: unknown;
};

/**
 * Why the DOM recorder stopped recording changes for a while (pressure mode) or for good:
 * - `mutation-cost`: rrweb's main-thread time over its budget;
 * - `mutation-size`: one change set larger than a batch may carry (the change was dropped);
 * - `element-limit`: the page has more elements than rrweb may record (the agent's own DOM
 *   capture takes over);
 * - `start-failed`: rrweb could not start on this page.
 */
export const RRWEB_RECORDER_REASONS = [
  "mutation-cost",
  "mutation-size",
  "element-limit",
  "start-failed"
] as const;

export type RrwebRecorderReason = (typeof RRWEB_RECORDER_REASONS)[number];

/**
 * A change of the DOM recorder's state, carried by a batch. `paused` and `disabled` take effect
 * after the batch's events: `paused` opens a gap in the change log, `disabled` ends rrweb recording
 * on this page (the agent's own DOM capture takes over). `resumed` closes a gap: the batch starts
 * with a fresh full snapshot.
 */
export type RrwebRecorderState = {
  status: "paused" | "resumed" | "disabled";
  reason?: RrwebRecorderReason;
  /** Elements of the page when the state changed (`disabled` by `element-limit`). */
  elements?: number;
  /** rrweb's main-thread milliseconds in the window that paused it (`mutation-cost`). */
  costMs?: number;
};

export type RrwebEventBatchPayload = {
  schema: typeof RRWEB_EVENT_SCHEMA;
  events: RrwebRecordedEvent[];
  recorder?: RrwebRecorderState;
};

const RRWEB_RECORDER_STATUSES: ReadonlySet<string> = new Set(["paused", "resumed", "disabled"]);
const RRWEB_RECORDER_REASON_SET: ReadonlySet<string> = new Set(RRWEB_RECORDER_REASONS);

function isRrwebRecordedEvent(value: unknown): value is RrwebRecordedEvent {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "number" &&
    Number.isFinite(candidate.type) &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  );
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/** True for a well-formed recorder state (unknown statuses and reasons are rejected). */
export function isRrwebRecorderState(value: unknown): value is RrwebRecorderState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === "string" &&
    RRWEB_RECORDER_STATUSES.has(candidate.status) &&
    (candidate.reason === undefined ||
      (typeof candidate.reason === "string" && RRWEB_RECORDER_REASON_SET.has(candidate.reason))) &&
    isOptionalFiniteNumber(candidate.elements) &&
    isOptionalFiniteNumber(candidate.costMs)
  );
}

/** True for a `dom.rrweb.event` payload that carries real rrweb events. */
export function isRrwebEventBatchPayload(value: unknown): value is RrwebEventBatchPayload {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === RRWEB_EVENT_SCHEMA &&
    Array.isArray(candidate.events) &&
    candidate.events.every(isRrwebRecordedEvent) &&
    (candidate.recorder === undefined || isRrwebRecorderState(candidate.recorder))
  );
}
