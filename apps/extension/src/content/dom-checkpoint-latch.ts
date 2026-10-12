import { RRWEB_RAW_TYPE } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

export type DomCheckpointLatch = {
  /** Events the queue dropped on overflow. */
  noteDropped: (events: readonly RawRecorderEvent[]) => void;
  /** The queue is empty again: the one checkpoint owed, if any, is requested now. */
  queueDrained: () => void;
  reset: () => void;
};

/**
 * A lost rrweb batch breaks DOM replay until the next full snapshot. The content script asks for
 * one once its queue drains, not on every overflow: a snapshot taken while the queue still
 * overflows (port down, service worker stalled) would be dropped too and ask for another, a full
 * snapshot per overflow on the page's main thread.
 */
export function createDomCheckpointLatch(request: () => void): DomCheckpointLatch {
  let due = false;

  return {
    noteDropped: (events) => {
      due ||= events.some((event) => event.rawType === RRWEB_RAW_TYPE);
    },
    queueDrained: () => {
      if (due) {
        due = false;
        request();
      }
    },
    reset: () => {
      due = false;
    }
  };
}
