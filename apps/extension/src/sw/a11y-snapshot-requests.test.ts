import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import type { A11ySnapshotRequestMessage } from "../shared/messages.js";
import {
  A11Y_SNAPSHOT_REQUEST_MIN_INTERVAL_MS,
  createA11ySnapshotRequester
} from "./a11y-snapshot-requests.js";
import type { SessionRuntime } from "./session-registry.js";

function runtime(mode: "lite" | "full", stopping = false): SessionRuntime {
  return { sid: "S-1", tabId: 9, mode, stopping } as SessionRuntime;
}

function event(type: string, data: unknown = {}, id = "E-1"): WebBlackboxEvent {
  return { v: 1, sid: "S-1", tab: 9, t: 1, mono: 1, type, id, data } as WebBlackboxEvent;
}

function setup(send = vi.fn(async () => undefined)) {
  let now = 0;
  const requester = createA11ySnapshotRequester({ sendToTab: send, now: () => now });
  return { requester, send, advance: (ms: number) => (now += ms) };
}

describe("createA11ySnapshotRequester", () => {
  it("asks a Full mode page for a snapshot after an error the debugger saw", () => {
    const { requester, send } = setup();
    requester.onEvent(runtime("full"), event("error.exception", {}, "E-7"));

    expect(send).toHaveBeenCalledWith(9, {
      kind: "sw.a11y-snapshot-request",
      sid: "S-1",
      trigger: { kind: "error", rawType: "error.exception", eventId: "E-7" }
    } satisfies A11ySnapshotRequestMessage);
  });

  it("counts console errors and unhandled rejections, not other events", () => {
    const { requester, send, advance } = setup();
    const full = runtime("full");

    for (const [type, data] of [
      ["console.entry", { level: "warn" }],
      ["user.click", {}],
      ["network.failed", {}],
      ["console.entry", { level: "error" }],
      ["error.unhandledrejection", {}]
    ] as const) {
      requester.onEvent(full, event(type, data));
      advance(A11Y_SNAPSHOT_REQUEST_MIN_INTERVAL_MS);
    }

    expect(
      send.mock.calls.map((call) => (call[1] as A11ySnapshotRequestMessage).trigger.rawType)
    ).toEqual(["console.entry", "error.unhandledrejection"]);
  });

  it("leaves lite mode (the page sees its errors) and stopping sessions alone", () => {
    const { requester, send } = setup();
    requester.onEvent(runtime("lite"), event("error.exception"));
    requester.onEvent(runtime("full", true), event("error.exception"));

    expect(send).not.toHaveBeenCalled();
  });

  it("sends at most one request per interval per session", () => {
    const { requester, send, advance } = setup();
    const full = runtime("full");

    for (let index = 0; index < 50; index += 1) {
      requester.onEvent(full, event("error.exception", {}, `E-${index}`));
      advance(10);
    }

    expect(send).toHaveBeenCalledTimes(1);
    advance(A11Y_SNAPSHOT_REQUEST_MIN_INTERVAL_MS);
    requester.onEvent(full, event("error.exception"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("logs a request the tab could not receive", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { requester } = setup(vi.fn(async () => Promise.reject(new Error("no receiver"))));
    requester.onEvent(runtime("full"), event("error.exception"));
    await vi.waitFor(() => expect(debug).toHaveBeenCalled());

    debug.mockRestore();
  });
});
