/**
 * Real rrweb 2.x events inside `dom.rrweb.event` (spike, task 56). The page batches the events
 * rrweb emits and records one `dom.rrweb.event` per batch; the older `rrweb-lite/v1` payloads
 * (mutation summaries) keep their own schema tag.
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
  mouseInteraction: 2
} as const;

/** One rrweb event as recorded (`eventWithTime`); `data` stays rrweb's own shape. */
export type RrwebRecordedEvent = {
  type: number;
  timestamp: number;
  data: unknown;
};

export type RrwebEventBatchPayload = {
  schema: typeof RRWEB_EVENT_SCHEMA;
  events: RrwebRecordedEvent[];
};

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

/** True for a `dom.rrweb.event` payload that carries real rrweb events. */
export function isRrwebEventBatchPayload(value: unknown): value is RrwebEventBatchPayload {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === RRWEB_EVENT_SCHEMA &&
    Array.isArray(candidate.events) &&
    candidate.events.every(isRrwebRecordedEvent)
  );
}
