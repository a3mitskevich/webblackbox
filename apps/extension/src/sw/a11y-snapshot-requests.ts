import type { WebBlackboxEvent } from "@webblackbox/protocol";

import type { A11ySnapshotRequestMessage } from "../shared/messages.js";
import type { SessionRuntime } from "./session-registry.js";

/** Shortest gap between two requests for one session; the page folds what arrives meanwhile. */
export const A11Y_SNAPSHOT_REQUEST_MIN_INTERVAL_MS = 1_000;

export type A11ySnapshotRequesterDeps = {
  sendToTab: (tabId: number, message: A11ySnapshotRequestMessage) => Promise<unknown>;
  now: () => number;
};

export type A11ySnapshotRequester = {
  /** Called for every recorded event of a session. */
  onEvent: (runtime: SessionRuntime, event: WebBlackboxEvent) => void;
};

/**
 * Full mode records errors through the debugger, so the page never sees them: each one asks the
 * recorded tab's capture agent for an accessibility snapshot, linked to the error event.
 */
export function createA11ySnapshotRequester(
  deps: A11ySnapshotRequesterDeps
): A11ySnapshotRequester {
  const lastRequestAt = new WeakMap<SessionRuntime, number>();

  function onEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
    if (runtime.mode !== "full" || runtime.stopping || !isErrorEvent(event)) {
      return;
    }

    const now = deps.now();

    if (
      now - (lastRequestAt.get(runtime) ?? Number.NEGATIVE_INFINITY) <
      A11Y_SNAPSHOT_REQUEST_MIN_INTERVAL_MS
    ) {
      return;
    }

    lastRequestAt.set(runtime, now);
    deps
      .sendToTab(runtime.tabId, {
        kind: "sw.a11y-snapshot-request",
        sid: runtime.sid,
        trigger: { kind: "error", rawType: event.type, eventId: event.id }
      })
      .catch((error: unknown) => {
        // The tab may be navigating; the next error or the stop snapshot covers it.
        console.debug("[WebBlackbox] accessibility snapshot request not delivered", {
          sid: runtime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  return { onEvent };
}

function isErrorEvent(event: WebBlackboxEvent): boolean {
  if (event.type === "error.exception" || event.type === "error.unhandledrejection") {
    return true;
  }

  return (
    event.type === "console.entry" &&
    typeof event.data === "object" &&
    event.data !== null &&
    (event.data as Record<string, unknown>).level === "error"
  );
}
