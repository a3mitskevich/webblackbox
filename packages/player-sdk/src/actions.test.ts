import type { WebBlackboxEvent, WebBlackboxEventType } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { deriveActionView } from "./actions.js";

function event(
  id: string,
  type: WebBlackboxEventType,
  mono: number,
  act?: string
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: mono,
    mono,
    type,
    id,
    data: {},
    ...(act ? { ref: { act } } : {})
  };
}

describe("deriveActionView", () => {
  it("keeps the user event as the trigger when a linked event sorts before it", () => {
    // An rrweb batch is stamped with its first event (the click rrweb saw), a few ms ahead of
    // our own click record; both are linked to the action.
    const view = deriveActionView([
      event("E-2", "dom.rrweb.event", 100, "A-1"),
      event("E-1", "user.click", 103, "A-1"),
      event("E-3", "network.request", 140, "A-1"),
      event("E-4", "user.keydown", 150, "A-1")
    ]);

    expect(view.actionSpans).toEqual([
      expect.objectContaining({
        actId: "A-1",
        triggerEventId: "E-1",
        startMono: 100,
        endMono: 150,
        requestCount: 1
      })
    ]);
  });

  it("keeps the first event when the span has no user event", () => {
    const view = deriveActionView([
      event("E-1", "network.request", 10, "A-1"),
      event("E-2", "dom.rrweb.event", 20, "A-1")
    ]);

    expect(view.actionSpans[0]?.triggerEventId).toBe("E-1");
  });
});
