import type { SessionRuntime } from "./session-registry.js";

export type SessionQueueDeps = {
  /** Best-effort tasks (action screenshots) drop beyond this per-session backlog. */
  bestEffortQueueMaxPending: number;
  shouldLogPerf: () => boolean;
};

export type SessionQueue = {
  enqueue: (
    runtime: SessionRuntime,
    task: () => Promise<void>,
    options?: { bestEffort?: boolean }
  ) => boolean;
  enqueueWithResult: <TResult>(
    runtime: SessionRuntime,
    task: () => Promise<TResult>
  ) => Promise<TResult>;
};

/**
 * Per-session FIFO task queue: each runtime serializes its asynchronous work (event ingest,
 * lite materialization, artifact captures) through `runtime.queue`, so the pipeline sees events
 * in the page's order. A failed task is logged and the queue moves on; best-effort tasks drop
 * instead of growing the backlog without bound.
 */
export function createSessionQueue(deps: SessionQueueDeps): SessionQueue {
  function enqueue(
    runtime: SessionRuntime,
    task: () => Promise<void>,
    options: { bestEffort?: boolean } = {}
  ): boolean {
    if (options.bestEffort) {
      if (runtime.stopping || runtime.queueDepth >= deps.bestEffortQueueMaxPending) {
        runtime.droppedBestEffortTasks += 1;

        if (deps.shouldLogPerf() && runtime.droppedBestEffortTasks % 50 === 0) {
          console.info("[WebBlackbox][perf] dropped best-effort queue tasks", {
            sid: runtime.sid,
            dropped: runtime.droppedBestEffortTasks,
            queueDepth: runtime.queueDepth
          });
        }

        return false;
      }
    }

    runtime.queueDepth += 1;
    runtime.queue = runtime.queue
      .then(task)
      .catch((error) => {
        console.warn("[WebBlackbox] session queue error", error);
      })
      .finally(() => {
        runtime.queueDepth = Math.max(0, runtime.queueDepth - 1);
      });

    return true;
  }

  function enqueueWithResult<TResult>(
    runtime: SessionRuntime,
    task: () => Promise<TResult>
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      enqueue(runtime, async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  return { enqueue, enqueueWithResult };
}
