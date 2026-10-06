import type { WebBlackboxEvent } from "@webblackbox/protocol";

import type { SessionRuntime } from "./session-registry.js";

const PIPELINE_BATCH_MAX_EVENTS = 160;
const PIPELINE_BATCH_DRAIN_CHUNK_EVENTS = 160;
const PIPELINE_BATCH_FLUSH_MS = 120;

export type PipelineBufferDeps = {
  enqueue: (
    runtime: SessionRuntime,
    task: () => Promise<void>,
    options?: { bestEffort?: boolean }
  ) => boolean;
  enqueueWithResult: <TResult>(
    runtime: SessionRuntime,
    task: () => Promise<TResult>
  ) => Promise<TResult>;
  wait: (durationMs: number) => Promise<void>;
  shouldLogPerf: () => boolean;
};

export type PipelineBuffer = {
  /** Buffers a recorded event; the batch flushes when full or after a short quiet window. */
  enqueuePipelineEvent: (runtime: SessionRuntime, event: WebBlackboxEvent) => void;
  /** Sends everything buffered, in order, through the session's ordered queue. */
  flushBufferedPipelineEvents: (runtime: SessionRuntime) => Promise<void>;
};

/**
 * Per-session pipeline event batching: recorder events accumulate in `pipelineEventBuffer` and
 * cross to the offscreen pipeline in chunks, so a burst costs one port round-trip per batch
 * instead of one per event. All writes go through the session's ordered queue.
 */
export function createPipelineBuffer(deps: PipelineBufferDeps): PipelineBuffer {
  function enqueuePipelineEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
    runtime.pipelineEventBuffer.push(event);

    if (runtime.pipelineEventBuffer.length >= PIPELINE_BATCH_MAX_EVENTS) {
      queuePipelineBatchFlush(runtime);
      return;
    }

    if (runtime.pipelineFlushTimer !== null || runtime.pipelineFlushQueued) {
      return;
    }

    runtime.pipelineFlushTimer = setTimeout(() => {
      runtime.pipelineFlushTimer = null;
      queuePipelineBatchFlush(runtime);
    }, PIPELINE_BATCH_FLUSH_MS);
  }

  function queuePipelineBatchFlush(runtime: SessionRuntime): void {
    if (runtime.pipelineFlushTimer !== null) {
      clearTimeout(runtime.pipelineFlushTimer);
      runtime.pipelineFlushTimer = null;
    }

    if (runtime.pipelineFlushQueued || runtime.pipelineEventBuffer.length === 0) {
      return;
    }

    runtime.pipelineFlushQueued = true;

    deps.enqueue(runtime, async () => {
      try {
        await drainPipelineBufferBatches(runtime, "queue");
      } finally {
        runtime.pipelineFlushQueued = false;

        if (runtime.pipelineEventBuffer.length > 0 && !runtime.stopping) {
          queuePipelineBatchFlush(runtime);
        }
      }
    });
  }

  async function flushBufferedPipelineEvents(runtime: SessionRuntime): Promise<void> {
    if (runtime.pipelineFlushTimer !== null) {
      clearTimeout(runtime.pipelineFlushTimer);
      runtime.pipelineFlushTimer = null;
    }

    if (runtime.pipelineEventBuffer.length === 0 && !runtime.pipelineFlushQueued) {
      return;
    }

    await deps.enqueueWithResult(runtime, async () => {
      await drainPipelineBufferBatches(runtime, "drain");
    });
  }

  async function drainPipelineBufferBatches(
    runtime: SessionRuntime,
    reason: "queue" | "drain"
  ): Promise<void> {
    let flushed = 0;

    while (runtime.pipelineEventBuffer.length > 0) {
      const batchSize = Math.min(
        runtime.pipelineEventBuffer.length,
        PIPELINE_BATCH_DRAIN_CHUNK_EVENTS
      );
      const batch = runtime.pipelineEventBuffer.slice(0, batchSize);

      if (batch.length === 0) {
        break;
      }

      // The pipeline serializes each event once; its byte count is the session size.
      runtime.capturedSizeBytes += await runtime.pipeline.ingestBatch(batch);
      runtime.pipelineEventBuffer.splice(0, batch.length);
      flushed += batch.length;

      if (runtime.pipelineEventBuffer.length > 0) {
        await deps.wait(0);
      }
    }

    if (deps.shouldLogPerf() && flushed > 0) {
      console.info("[WebBlackbox][perf] pipeline buffer flushed", {
        sid: runtime.sid,
        reason,
        flushed,
        queueDepth: runtime.queueDepth,
        stopping: runtime.stopping
      });
    }
  }

  return {
    enqueuePipelineEvent,
    flushBufferedPipelineEvents
  };
}
