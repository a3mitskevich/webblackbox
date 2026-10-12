import { RRWEB_RAW_TYPE } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

export type DomCheckpointLatch = {
  /** Events the queue dropped on overflow. */
  noteDropped: (events: readonly RawRecorderEvent[]) => void;
  /** The queue sent a chunk and holds `queued` events: the checkpoint owed is asked for once it has room. */
  queueFlushed: (queued: number) => void;
  reset: () => void;
};

/**
 * A lost rrweb batch breaks DOM replay until the next full snapshot. The content script asks for
 * one once its queue is back under `lowWater`, not on every overflow: a snapshot taken while the
 * queue still overflows (port down, service worker stalled) would be dropped too and ask for
 * another, a full snapshot per overflow on the page's main thread. `request` returns false when no
 * recorder took the request; it stays owed.
 */
export function createDomCheckpointLatch(
  request: () => boolean,
  lowWater: number
): DomCheckpointLatch {
  let due = false;

  return {
    noteDropped: (events) => {
      due ||= events.some((event) => event.rawType === RRWEB_RAW_TYPE);
    },
    queueFlushed: (queued) => {
      if (due && queued <= lowWater && request()) {
        due = false;
      }
    },
    reset: () => {
      due = false;
    }
  };
}
