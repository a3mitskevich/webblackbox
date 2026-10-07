import { describe, expect, it, vi } from "vitest";

import type { SessionRuntime } from "./session-registry.js";
import { createSessionQueue } from "./session-queue.js";

function createRuntime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sid: "S-1",
    stopping: false,
    queueDepth: 0,
    droppedBestEffortTasks: 0,
    queue: Promise.resolve(),
    ...overrides
  } as unknown as SessionRuntime;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("createSessionQueue", () => {
  it("runs enqueued tasks one at a time in order", async () => {
    const queue = createSessionQueue({
      bestEffortQueueMaxPending: 2,
      shouldLogPerf: () => false
    });
    const runtime = createRuntime();
    const gate = deferred();
    const order: string[] = [];

    queue.enqueue(runtime, async () => {
      await gate.promise;
      order.push("first");
    });
    queue.enqueue(runtime, async () => {
      order.push("second");
    });

    expect(order).toEqual([]);
    gate.resolve();
    await runtime.queue;

    expect(order).toEqual(["first", "second"]);
    expect(runtime.queueDepth).toBe(0);
  });

  it("resolves enqueueWithResult with the task value, after earlier tasks", async () => {
    const queue = createSessionQueue({
      bestEffortQueueMaxPending: 2,
      shouldLogPerf: () => false
    });
    const runtime = createRuntime();
    const order: string[] = [];

    queue.enqueue(runtime, async () => {
      order.push("plain");
    });
    const result = queue.enqueueWithResult(runtime, async () => {
      order.push("withResult");
      return 42;
    });

    await expect(result).resolves.toBe(42);
    expect(order).toEqual(["plain", "withResult"]);
  });

  it("rejects enqueueWithResult when the task fails and keeps the queue going", async () => {
    const queue = createSessionQueue({
      bestEffortQueueMaxPending: 2,
      shouldLogPerf: () => false
    });
    const runtime = createRuntime();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failure = queue.enqueueWithResult(runtime, async () => {
      throw new Error("boom");
    });

    await expect(failure).rejects.toThrow("boom");

    const after = queue.enqueueWithResult(runtime, async () => "recovered");
    await expect(after).resolves.toBe("recovered");
    expect(runtime.queueDepth).toBe(0);

    warn.mockRestore();
  });

  it("drops best-effort tasks beyond the pending cap", async () => {
    const queue = createSessionQueue({
      bestEffortQueueMaxPending: 1,
      shouldLogPerf: () => false
    });
    const runtime = createRuntime();
    const gate = deferred();

    queue.enqueue(runtime, () => gate.promise);
    expect(runtime.queueDepth).toBe(1);

    const dropped = queue.enqueue(runtime, async () => undefined, { bestEffort: true });

    expect(dropped).toBe(false);
    expect(runtime.droppedBestEffortTasks).toBe(1);
    expect(runtime.queueDepth).toBe(1);

    gate.resolve();
    await runtime.queue;
  });

  it("drops best-effort tasks while the session is stopping", () => {
    const queue = createSessionQueue({
      bestEffortQueueMaxPending: 10,
      shouldLogPerf: () => false
    });
    const runtime = createRuntime({ stopping: true });

    expect(queue.enqueue(runtime, async () => undefined, { bestEffort: true })).toBe(false);
    expect(runtime.droppedBestEffortTasks).toBe(1);
    // A regular task still queues: the stop drain relies on it.
    expect(queue.enqueue(runtime, async () => undefined)).toBe(true);
  });
});
