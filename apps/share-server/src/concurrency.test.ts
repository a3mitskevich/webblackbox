import { describe, expect, it } from "vitest";

import { createConcurrencyLimiter } from "./concurrency.js";

describe("createConcurrencyLimiter", () => {
  it("runs at most maxConcurrent tasks at once and drains the queue in order", async () => {
    const limiter = createConcurrencyLimiter(2);
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const results = [1, 2, 3, 4].map((id) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            started.push(id);
            releases.push(() => {
              active -= 1;
              resolve(id);
            });
          })
      )
    );

    await flushMicrotasks();
    expect(started).toEqual([1, 2]);

    releases.shift()?.();
    await flushMicrotasks();
    expect(started).toEqual([1, 2, 3]);

    while (releases.length > 0) {
      releases.shift()?.();
      await flushMicrotasks();
    }

    await expect(Promise.all(results)).resolves.toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("releases the slot when a task rejects", async () => {
    const limiter = createConcurrencyLimiter(1);

    await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limiter.run(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("rejects a non-positive concurrency", () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/positive integer/);
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}
