import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPipelineBuffer, type PipelineBufferDeps } from "./pipeline-buffer.js";
import type { SessionRuntime } from "./session-registry.js";

const BATCH_MAX_EVENTS = 160;
const FLUSH_QUIET_MS = 120;
const BYTES_PER_EVENT = 10;

type RuntimeStub = SessionRuntime & { batches: string[][] };

function createRuntime(): RuntimeStub {
  const batches: string[][] = [];

  return {
    sid: "S-1",
    stopping: false,
    queueDepth: 0,
    capturedSizeBytes: 0,
    pipelineEventBuffer: [],
    pipelineFlushTimer: null,
    pipelineFlushQueued: false,
    pipeline: {
      ingestBatch: vi.fn(async (events: WebBlackboxEvent[]) => {
        batches.push(events.map((event) => event.id));
        return events.length * BYTES_PER_EVENT;
      })
    },
    batches
  } as unknown as RuntimeStub;
}

function event(index: number): WebBlackboxEvent {
  return { id: `E-${index}` } as WebBlackboxEvent;
}

/** The session's ordered queue: tasks run one after another, as `enqueue` does. */
function createDeps(): PipelineBufferDeps & { idle: () => Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  const run = <TResult>(task: () => Promise<TResult>): Promise<TResult> => {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    enqueue: (_runtime, task) => {
      void run(task);
      return true;
    },
    enqueueWithResult: (_runtime, task) => run(task),
    wait: () => Promise.resolve(),
    shouldLogPerf: () => false,
    idle: () => tail
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPipelineBuffer", () => {
  it("holds a small burst until the quiet window, then sends it as one batch", async () => {
    const deps = createDeps();
    const buffer = createPipelineBuffer(deps);
    const runtime = createRuntime();

    buffer.enqueuePipelineEvent(runtime, event(1));
    buffer.enqueuePipelineEvent(runtime, event(2));
    await deps.idle();

    expect(runtime.batches).toEqual([]);

    await vi.advanceTimersByTimeAsync(FLUSH_QUIET_MS);
    await deps.idle();

    expect(runtime.batches).toEqual([["E-1", "E-2"]]);
    expect(runtime.pipelineEventBuffer).toEqual([]);
    expect(runtime.capturedSizeBytes).toBe(2 * BYTES_PER_EVENT);
  });

  it("sends a full batch at once without waiting for the quiet window", async () => {
    const deps = createDeps();
    const buffer = createPipelineBuffer(deps);
    const runtime = createRuntime();

    for (let index = 0; index < BATCH_MAX_EVENTS; index += 1) {
      buffer.enqueuePipelineEvent(runtime, event(index));
    }
    await deps.idle();

    expect(runtime.batches).toHaveLength(1);
    expect(runtime.batches[0]).toHaveLength(BATCH_MAX_EVENTS);
    expect(runtime.pipelineFlushTimer).toBeNull();
  });

  it("flushes everything buffered in order, in bounded chunks, and cancels the pending timer", async () => {
    const deps = createDeps();
    const buffer = createPipelineBuffer(deps);
    const runtime = createRuntime();
    const total = BATCH_MAX_EVENTS + 5;

    runtime.pipelineEventBuffer.push(...Array.from({ length: total }, (_, index) => event(index)));
    runtime.pipelineFlushTimer = setTimeout(() => undefined, FLUSH_QUIET_MS);

    await buffer.flushBufferedPipelineEvents(runtime);

    expect(runtime.pipelineFlushTimer).toBeNull();
    expect(runtime.batches.map((batch) => batch.length)).toEqual([BATCH_MAX_EVENTS, 5]);
    expect(runtime.batches.flat()).toEqual(
      Array.from({ length: total }, (_, index) => `E-${index}`)
    );
    expect(runtime.capturedSizeBytes).toBe(total * BYTES_PER_EVENT);
  });

  it("does not touch the queue when nothing is buffered", async () => {
    const deps = createDeps();
    const enqueueWithResult = vi.spyOn(deps, "enqueueWithResult");
    const buffer = createPipelineBuffer(deps);

    await buffer.flushBufferedPipelineEvents(createRuntime());

    expect(enqueueWithResult).not.toHaveBeenCalled();
  });
});
