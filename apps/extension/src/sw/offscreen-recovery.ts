import type { OffscreenClient } from "./offscreen-client.js";
import { toSessionMetadata } from "./session-list.js";
import type { SessionRuntime } from "./session-registry.js";

export type OffscreenSessionRecoveryDeps = {
  getRuntimeBySid: (sid: string) => SessionRuntime | undefined;
  tabRuntimes: () => IterableIterator<SessionRuntime>;
  offscreenClient: Pick<OffscreenClient, "requestOnce">;
  notifyOffscreenPipelineStatus: () => void;
};

export type OffscreenSessionRecovery = {
  recoverOffscreenSession: (sid: string) => Promise<void>;
  recoverAllActiveOffscreenPipelines: () => Promise<void>;
};

/**
 * Restarts a session's pipeline in a revived offscreen document. Concurrent recoveries of the
 * same session share one attempt; the dedupe entry clears when the attempt settles, so a failed
 * recovery is retried by the next request.
 */
export function createOffscreenSessionRecovery(
  deps: OffscreenSessionRecoveryDeps
): OffscreenSessionRecovery {
  const offscreenSessionRecovery = new Map<string, Promise<void>>();

  async function recoverOffscreenSession(sid: string): Promise<void> {
    const existing = offscreenSessionRecovery.get(sid);

    if (existing) {
      await existing;
      return;
    }

    const task = (async () => {
      const runtime = deps.getRuntimeBySid(sid);

      if (!runtime || runtime.stopping || runtime.stoppedAt) {
        return;
      }

      await deps.offscreenClient.requestOnce({
        op: "start",
        sid,
        session: toSessionMetadata(runtime),
        redactionProfile: runtime.config.redaction,
        capturePolicy: runtime.config.capturePolicy
      });
      deps.notifyOffscreenPipelineStatus();
    })()
      .catch((error) => {
        console.warn("[WebBlackbox] failed to recover offscreen pipeline session", {
          sid,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      })
      .finally(() => {
        offscreenSessionRecovery.delete(sid);
      });

    offscreenSessionRecovery.set(sid, task);
    await task;
  }

  async function recoverAllActiveOffscreenPipelines(): Promise<void> {
    for (const runtime of deps.tabRuntimes()) {
      if (runtime.stopping || runtime.stoppedAt) {
        continue;
      }

      await recoverOffscreenSession(runtime.sid);
    }
  }

  return { recoverOffscreenSession, recoverAllActiveOffscreenPipelines };
}
