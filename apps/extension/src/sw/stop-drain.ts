import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { SessionRuntime } from "./session-registry.js";

/** How long a stop waits for the content script's `content.stop-drained` acknowledgement. */
export const STOP_DRAIN_ACK_TIMEOUT_MS = 3_000;

/**
 * Raw event kinds a stopping session still records: the final snapshots the content script
 * captures while the stop drains. Everything else that arrives after Stop is dropped.
 */
export const STOP_DRAIN_CONTENT_RAW_TYPES: ReadonlySet<string> = new Set([
  "snapshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot",
  "screenshot"
]);

/**
 * Only while the stop drains: a snapshot that arrives after the drain (the session may already
 * be exported and deleted) would leave its blob behind in the pipeline's storage.
 */
export function shouldAllowStopDrainContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  return (
    rawEvent.source === "content" &&
    rawEvent.sid === runtime.sid &&
    runtime.stopDrained !== true &&
    STOP_DRAIN_CONTENT_RAW_TYPES.has(rawEvent.rawType)
  );
}

export type StopDrainAckState = {
  sid: string;
  tabId: number;
  ackReceived: boolean;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type StopDrainTrackerDeps = {
  getRuntimeBySid: (sid: string) => SessionRuntime | undefined;
};

export type StopDrainTracker = {
  /**
   * Counts `content.events` batches being applied per tab. A stop drain only resolves once the
   * tab's count is back at zero, so events read before Stop are not lost.
   */
  adjustInFlightContentMessages: (tabId: number, delta: 1 | -1) => void;
  inFlightContentMessages: (tabId: number) => number;
  /** Resolves once the content script acked the drain (or the timeout fires) and the tab idled. */
  createStopDrainAck: (runtime: SessionRuntime) => Promise<void>;
  markStopDrainAckReceived: (sid: string) => void;
  pendingStopDrainAckCount: () => number;
};

/**
 * The stop-drain handshake: Stop asks the content script for its last events and waits for the
 * ack, bounded by a timeout, and for the tab's in-flight content batches to finish. When the ack
 * lands, the session's ordered queue still drains before the wait resolves.
 */
export function createStopDrainTracker(deps: StopDrainTrackerDeps): StopDrainTracker {
  const pendingStopDrainAcks = new Map<string, StopDrainAckState>();
  const inFlightContentMessagesByTab = new Map<number, number>();

  function adjustInFlightContentMessages(tabId: number, delta: 1 | -1): void {
    const next = (inFlightContentMessagesByTab.get(tabId) ?? 0) + delta;

    if (next <= 0) {
      inFlightContentMessagesByTab.delete(tabId);
      resolveStopDrainAcksForTab(tabId);
      return;
    }

    inFlightContentMessagesByTab.set(tabId, next);
  }

  function createStopDrainAck(runtime: SessionRuntime): Promise<void> {
    const existing = pendingStopDrainAcks.get(runtime.sid);

    if (existing) {
      clearTimeout(existing.timeout);
      pendingStopDrainAcks.delete(runtime.sid);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingStopDrainAcks.delete(runtime.sid);
        resolve();
      }, STOP_DRAIN_ACK_TIMEOUT_MS);

      pendingStopDrainAcks.set(runtime.sid, {
        sid: runtime.sid,
        tabId: runtime.tabId,
        ackReceived: false,
        resolve,
        timeout
      });
    });
  }

  function markStopDrainAckReceived(sid: string): void {
    const pending = pendingStopDrainAcks.get(sid);

    if (!pending) {
      return;
    }

    pending.ackReceived = true;
    resolveStopDrainAckIfReady(pending);
  }

  function resolveStopDrainAcksForTab(tabId: number): void {
    for (const pending of pendingStopDrainAcks.values()) {
      if (pending.tabId === tabId) {
        resolveStopDrainAckIfReady(pending);
      }
    }
  }

  function resolveStopDrainAckIfReady(pending: StopDrainAckState): void {
    if (!pending.ackReceived) {
      return;
    }

    if ((inFlightContentMessagesByTab.get(pending.tabId) ?? 0) > 0) {
      return;
    }

    pendingStopDrainAcks.delete(pending.sid);
    clearTimeout(pending.timeout);

    const runtime = deps.getRuntimeBySid(pending.sid);

    if (!runtime) {
      pending.resolve();
      return;
    }

    void runtime.queue.finally(() => {
      pending.resolve();
    });
  }

  return {
    adjustInFlightContentMessages,
    inFlightContentMessages: (tabId) => inFlightContentMessagesByTab.get(tabId) ?? 0,
    createStopDrainAck,
    markStopDrainAckReceived,
    pendingStopDrainAckCount: () => pendingStopDrainAcks.size
  };
}
