import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThrottledPush } from "./throttled-push.js";

const INTERVAL_MS = 500;

describe("createThrottledPush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes the first scheduled call at once and coalesces a burst into one trailing push", () => {
    const push = vi.fn();
    const throttled = createThrottledPush(push, INTERVAL_MS);

    throttled.schedule();
    expect(push).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 1_000; index += 1) {
      throttled.schedule();
    }

    expect(push).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(push).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("pushes at once again after a quiet interval", () => {
    const push = vi.fn();
    const throttled = createThrottledPush(push, INTERVAL_MS);

    throttled.schedule();
    vi.advanceTimersByTime(INTERVAL_MS);
    throttled.schedule();

    expect(push).toHaveBeenCalledTimes(2);
  });

  it("an immediate push cancels the scheduled one", () => {
    const push = vi.fn();
    const throttled = createThrottledPush(push, INTERVAL_MS);

    throttled.schedule();
    throttled.schedule();
    throttled.now();
    expect(push).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(push).toHaveBeenCalledTimes(2);
  });
});
