import { describe, expect, it, vi } from "vitest";

import {
  enableChildSessionCapture,
  withCdpCommandTimeout,
  type ChildSessionRouter
} from "./cdp-command.js";

const TAB_ID = 7;
const CHILD_SESSION_ID = "child-1";
const STEP_TIMEOUT_MS = 250;

function createChildRouter(hangingMethods: readonly string[] = []) {
  const sent: string[] = [];
  const respond = (method: string): Promise<undefined> => {
    sent.push(method);
    return hangingMethods.includes(method)
      ? new Promise(() => undefined)
      : Promise.resolve(undefined);
  };

  const send = vi.fn((_target: unknown, method: string) => respond(method));

  return {
    sent,
    send,
    router: {
      enableBaseline: vi.fn(async () => {
        await respond("Network.enable");
        await respond("Log.enable");
      }),
      enableAutoAttach: vi.fn(async () => {
        await respond("Target.setAutoAttach");
      }),
      // The real router's send is generic over the result type; the fake only resolves undefined.
      send: send as unknown as ChildSessionRouter["send"]
    }
  };
}

describe("cdp-command", () => {
  it("treats an undefined CDP result as a successful command", async () => {
    await expect(withCdpCommandTimeout(Promise.resolve(undefined), 1_000)).resolves.toEqual({
      ok: true,
      value: undefined
    });
  });

  it("returns a failed outcome when the command rejects", async () => {
    await expect(
      withCdpCommandTimeout(Promise.reject(new Error("cdp failed")), 1_000)
    ).resolves.toEqual({
      ok: false
    });
  });

  it("returns a failed outcome when the command times out", async () => {
    vi.useFakeTimers();

    try {
      const result = withCdpCommandTimeout(new Promise<string>(() => undefined), 250);

      await vi.advanceTimersByTimeAsync(250);

      await expect(result).resolves.toEqual({
        ok: false
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("enableChildSessionCapture", () => {
  it("enables the baseline, auto-attach and optional domains on the child session", async () => {
    const { router, send, sent } = createChildRouter();

    await expect(
      enableChildSessionCapture(router, TAB_ID, CHILD_SESSION_ID, STEP_TIMEOUT_MS)
    ).resolves.toBe(true);

    expect(sent).toEqual([
      "Network.enable",
      "Log.enable",
      "Target.setAutoAttach",
      "DOMStorage.enable",
      "Performance.enable"
    ]);
    expect(router.enableBaseline).toHaveBeenCalledWith(TAB_ID, CHILD_SESSION_ID);
    expect(router.enableAutoAttach).toHaveBeenCalledWith(TAB_ID, undefined, CHILD_SESSION_ID);
    expect(send).toHaveBeenCalledWith(
      { tabId: TAB_ID, sessionId: CHILD_SESSION_ID },
      "DOMStorage.enable"
    );
  });

  it("gives up after one step timeout when a required command never answers", async () => {
    vi.useFakeTimers();

    try {
      // A child target that goes away mid-handshake can leave a chrome.debugger command pending
      // forever; priming runs on the session queue, so it must not wait for it.
      const { router, sent } = createChildRouter(["Log.enable"]);
      const primed = enableChildSessionCapture(router, TAB_ID, CHILD_SESSION_ID, STEP_TIMEOUT_MS);

      await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS);

      await expect(primed).resolves.toBe(false);
      expect(sent).toEqual(["Network.enable", "Log.enable"]);
      expect(router.enableAutoAttach).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failure when a required command rejects", async () => {
    const { router, send } = createChildRouter();
    router.enableAutoAttach.mockRejectedValueOnce(new Error("No target with given id found"));

    await expect(
      enableChildSessionCapture(router, TAB_ID, CHILD_SESSION_ID, STEP_TIMEOUT_MS)
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("still succeeds when an optional domain never answers", async () => {
    vi.useFakeTimers();

    try {
      const { router, sent } = createChildRouter(["DOMStorage.enable"]);
      const primed = enableChildSessionCapture(router, TAB_ID, CHILD_SESSION_ID, STEP_TIMEOUT_MS);

      await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS);

      await expect(primed).resolves.toBe(true);
      expect(sent.at(-1)).toBe("Performance.enable");
    } finally {
      vi.useRealTimers();
    }
  });
});
