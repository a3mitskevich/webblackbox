import { afterEach, describe, expect, it, vi } from "vitest";

import { primeChildSession, type ChildSessionPrimer } from "./child-session-prime.js";

type RouterMock = {
  enableBaseline: ReturnType<typeof vi.fn>;
  enableAutoAttach: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function createRouter(overrides: Partial<RouterMock> = {}): RouterMock {
  return {
    enableBaseline: vi.fn(async () => undefined),
    enableAutoAttach: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    ...overrides
  };
}

function prime(router: RouterMock, sessionId: string, timeoutMs: number): Promise<boolean> {
  return primeChildSession(router as unknown as ChildSessionPrimer, 7, sessionId, timeoutMs);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("primeChildSession", () => {
  it("enables the baseline domains, auto-attach, DOM storage and performance in order", async () => {
    const router = createRouter();

    await expect(prime(router, "child-1", 1_000)).resolves.toBe(true);
    expect(router.enableBaseline).toHaveBeenCalledWith(7, "child-1");
    expect(router.enableAutoAttach).toHaveBeenCalledWith(7, undefined, "child-1");
    expect(router.send.mock.calls.map((call) => call[1])).toEqual([
      "DOMStorage.enable",
      "Performance.enable"
    ]);
  });

  it("reports failure when a required domain is rejected (e.g. Page.enable on a worker)", async () => {
    const router = createRouter({
      enableBaseline: vi.fn(async () => {
        throw new Error("'Page.enable' wasn't found");
      })
    });

    await expect(prime(router, "worker-1", 1_000)).resolves.toBe(false);
    expect(router.enableAutoAttach).not.toHaveBeenCalled();
  });

  it("ignores optional domains the target does not support", async () => {
    const router = createRouter({
      send: vi.fn(async () => {
        throw new Error("not supported");
      })
    });

    await expect(prime(router, "child-1", 1_000)).resolves.toBe(true);
  });

  it("gives up on a child target that never answers instead of stalling the caller", async () => {
    // A worker terminated right after it attached: chrome.debugger never answers its session.
    vi.useFakeTimers();
    const router = createRouter({
      enableBaseline: vi.fn(() => new Promise<void>(() => undefined))
    });

    const primed = prime(router, "gone-1", 5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(primed).resolves.toBe(false);
  });
});
