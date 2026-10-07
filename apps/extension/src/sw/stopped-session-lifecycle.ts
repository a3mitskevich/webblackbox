import type { PipelineSessionSweepResult } from "@webblackbox/pipeline/storage";
import type { SessionMetadata } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";

import type { PerformanceBudgetConfig } from "../shared/performance-budget.js";
import { resolveUnexportedRetentionMs } from "../shared/profiles/local-data.js";
import type { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionRuntime,
  type SessionAnnotation,
  type SessionRegistry,
  type SessionRuntime
} from "./session-registry.js";
import {
  clearRetentionAlarm,
  createStoppedSessionStore,
  MAX_STOPPED_SESSION_PURGE_ATTEMPTS,
  planStoppedSessionRestore,
  scheduleRetentionAlarm,
  type RetentionAlarmsLike,
  type SnapshotStorageAreaLike,
  type StoppedSessionSnapshot
} from "./stopped-session-store.js";
import {
  parseStoppedSessionRecords,
  pruneStoppedSessionRecords,
  removeStoppedSessionRecord,
  resolveStoppedSessionTtlMs,
  shouldSweepStoredSession,
  STOPPED_SESSIONS_STORAGE_KEY,
  upsertStoppedSessionRecord,
  type StoppedSessionRecord
} from "./stopped-sessions.js";

/** A failed purge of a stopped recording is retried this much later. */
export const STOPPED_SESSION_PURGE_RETRY_MS = 5 * 60_000;

/**
 * What the lifecycle needs from the rest of the worker: the session registry, the storage
 * areas, the at-rest key state, pipeline factories and the user-facing notifications
 * (badge, session list, offscreen status) a purge triggers.
 */
export type StoppedSessionLifecycleDeps = {
  sessionRegistry: SessionRegistry;
  alarms: RetentionAlarmsLike | undefined;
  sessionStorageArea: SnapshotStorageAreaLike | undefined;
  localStorageArea: SnapshotStorageAreaLike | undefined;
  closeOffscreenDocument: () => Promise<void>;
  getAtRestKey: () => Promise<unknown>;
  /** This worker minted the key: a new browser session, nothing stored before is readable. */
  isAtRestKeyFresh: () => boolean;
  waitForRuntimeState: () => Promise<void>;
  loadPerformanceBudgetConfig: () => Promise<PerformanceBudgetConfig>;
  getSessionAnnotation: (sid: string) => SessionAnnotation;
  createPipeline: (sid: string) => SessionPipelineClient;
  /** Matches `SessionRuntimeDeps.createFullBodyCapture`; wired into every restored runtime. */
  createFullBodyCapture: (getRuntime: () => SessionRuntime) => FullBodyCapture;
  toSessionMetadata: (runtime: SessionRuntime) => SessionMetadata;
  flushBufferedPipelineEvents: (runtime: SessionRuntime) => Promise<void>;
  refreshActionBadge: () => Promise<void>;
  pushSessionList: () => void;
  persistRuntimeState: () => Promise<void>;
  notifyOffscreenPipelineStatus: () => void;
  indexedDB: IDBFactory | undefined;
  /** Deletes the stored pipeline sessions the predicate accepts; the storage lives outside. */
  sweepStoredSessions: (
    shouldDelete: (session: SessionMetadata) => boolean
  ) => Promise<PipelineSessionSweepResult>;
  /** When this worker booted: sessions started later are never swept. */
  bootedAt: number;
};

export type StoppedSessionLifecycleController = {
  /** Snapshot of a stopped recording, so a later worker can list, export or expire it. */
  rememberStoppedSession: (runtime: SessionRuntime) => Promise<void>;
  forgetStoppedSession: (sid: string) => Promise<void>;
  toStoppedSessionSnapshot: (runtime: SessionRuntime) => StoppedSessionSnapshot;
  /** Rebuilds the stopped recordings an earlier worker of this browser session left. */
  restoreStoppedSessions: () => Promise<void>;
  /** Gives the offscreen document the pipeline of a stopped recording it does not hold. */
  attachStoppedPipeline: (runtime: SessionRuntime) => Promise<void>;
  /** A new offscreen document holds no pipeline of the stopped recordings. */
  markStoppedPipelinesDetached: () => void;
  expireStoppedSession: (sid: string) => Promise<void>;
  scheduleStoppedRuntimeCleanup: (runtime: SessionRuntime) => void;
  rememberStoppedSessionRecord: (runtime: SessionRuntime) => Promise<void>;
  /** Deletes pipeline data no live runtime can reach any more; runs on worker start. */
  sweepStalePipelineSessions: () => Promise<void>;
  disposeStoppedSession: (runtime: SessionRuntime) => Promise<void>;
};

/**
 * The stopped-session lifecycle: snapshots kept in `storage.session`, records kept in
 * `storage.local`, restore at worker start, TTL expiry and the purge retry path. The state
 * an earlier module level held (detached pipelines, pending attachments, the offscreen
 * generation, sessions being disposed, the records write queue) lives in this closure.
 */
export function createStoppedSessionLifecycle(
  deps: StoppedSessionLifecycleDeps
): StoppedSessionLifecycleController {
  const store = createStoppedSessionStore(deps.sessionStorageArea);
  /** Stopped sessions whose pipeline the current offscreen document does not hold (yet). */
  const detachedPipelineSids = new Set<string>();
  const pipelineAttachments = new Map<string, Promise<void>>();
  /** Bumped when the offscreen document goes away: attachments started before it are void. */
  let offscreenGeneration = 0;
  const disposingSids = new Set<string>();
  let stoppedSessionRecordsQueue: Promise<unknown> = Promise.resolve();

  async function rememberStoppedSession(runtime: SessionRuntime): Promise<void> {
    if (!runtime.stoppedAt || !deps.sessionRegistry.hasSid(runtime.sid)) {
      return;
    }

    await store.remember(toStoppedSessionSnapshot(runtime)).catch((error) => {
      console.warn("[WebBlackbox] failed to keep the stopped recording restorable", error);
    });
  }

  async function forgetStoppedSession(sid: string): Promise<void> {
    detachedPipelineSids.delete(sid);
    await store.forget(sid).catch((error) => {
      console.warn("[WebBlackbox] failed to drop a stopped recording's snapshot", error);
    });
    await clearRetentionAlarm(deps.alarms, sid).catch((error) => {
      console.warn("[WebBlackbox] failed to clear a stopped recording's retention alarm", error);
    });
  }

  function toStoppedSessionSnapshot(runtime: SessionRuntime): StoppedSessionSnapshot {
    const stoppedAt = runtime.stoppedAt ?? Date.now();

    return {
      sid: runtime.sid,
      tabId: runtime.tabId,
      mode: runtime.mode,
      startedAt: runtime.startedAt,
      stoppedAt,
      expiresAt: resolveStoppedSessionExpiresAt(runtime),
      url: runtime.url,
      title: runtime.title,
      profile: {
        request: runtime.profile.request,
        visualCapture: runtime.profile.visualCapture,
        selection: runtime.profile.selection,
        profileConfig: runtime.profile.profileConfig,
        visualsCaptured: runtime.profile.visualsCaptured,
        ...(runtime.profile.cancellation
          ? {
              cancellation: runtime.profile.cancellation,
              cancellationAcknowledged: runtime.profile.cancellationAcknowledged ?? false
            }
          : {})
      },
      config: runtime.config,
      counters: {
        eventCount: runtime.capturedEventCount,
        errorCount: runtime.capturedErrorCount,
        sizeBytes: runtime.capturedSizeBytes,
        budgetAlertCount: runtime.budgetAlertCount
      }
    };
  }

  /**
   * Rebuilds the stopped recordings an earlier worker of this browser session left: they are
   * listed and exportable again, and those past their retention are deleted. Nothing is
   * restored under a freshly minted key: the database was deleted with the old one.
   */
  async function restoreStoppedSessions(): Promise<void> {
    try {
      await deps.getAtRestKey();
    } catch {
      return;
    }

    if (deps.isAtRestKeyFresh()) {
      await store.clear().catch((error) => {
        console.warn("[WebBlackbox] failed to clear restored recording snapshots", error);
      });
      return;
    }

    const plan = planStoppedSessionRestore(await store.list(), Date.now());

    if (plan.kept.length + plan.purgeNow.length + plan.purgeLater.length === 0) {
      return;
    }

    const performanceBudget = await deps.loadPerformanceBudgetConfig();

    for (const snapshot of plan.kept) {
      scheduleStoppedRuntimeCleanup(restoreStoppedRuntime(snapshot, performanceBudget));
    }

    for (const snapshot of plan.purgeLater) {
      await scheduleRetentionAlarm(
        deps.alarms,
        snapshot.sid,
        Date.now() + STOPPED_SESSION_PURGE_RETRY_MS
      ).catch((error) => {
        console.warn("[WebBlackbox] failed to schedule a recording's purge retry", error);
      });
    }

    // All registered first, so the offscreen document is closed once, after the last purge. The
    // purges run one by one before any message is answered: in parallel they would race offscreen
    // creation, and one finishing late could close the document of a Start that just began.
    const expired = plan.purgeNow.map((snapshot) =>
      restoreStoppedRuntime(snapshot, performanceBudget)
    );

    for (const runtime of expired) {
      await disposeStoppedSession(runtime).catch((error) => {
        console.warn("[WebBlackbox] failed to delete an expired recording", error);
      });
    }

    console.info("[WebBlackbox] restored stopped recordings", {
      kept: plan.kept.length,
      purged: plan.purgeNow.length,
      retrying: plan.purgeLater.length
    });
  }

  function restoreStoppedRuntime(
    snapshot: StoppedSessionSnapshot,
    performanceBudget: PerformanceBudgetConfig
  ): SessionRuntime {
    const existing = deps.sessionRegistry.getBySid(snapshot.sid);

    if (existing) {
      return existing;
    }

    const runtime = createSessionRuntime(
      {
        sid: snapshot.sid,
        tabId: snapshot.tabId,
        mode: snapshot.mode,
        profile: snapshot.profile,
        url: snapshot.url,
        title: snapshot.title,
        annotation: deps.getSessionAnnotation(snapshot.sid),
        config: snapshot.config,
        startedAt: snapshot.startedAt,
        stoppedAt: snapshot.stoppedAt,
        pipeline: deps.createPipeline(snapshot.sid),
        recorderPlugins: createDefaultRecorderPlugins(),
        performanceBudget,
        counters: snapshot.counters
      },
      { createFullBodyCapture: deps.createFullBodyCapture }
    );

    deps.sessionRegistry.registerBySid(runtime);
    detachedPipelineSids.add(runtime.sid);
    return runtime;
  }

  function attachStoppedPipeline(runtime: SessionRuntime): Promise<void> {
    const sid = runtime.sid;

    if (!detachedPipelineSids.has(sid)) {
      return Promise.resolve();
    }

    const pending = pipelineAttachments.get(sid);

    if (pending) {
      return pending;
    }

    const generation = offscreenGeneration;
    const attachment = runtime.pipeline
      .start(
        deps.toSessionMetadata(runtime),
        runtime.config.redaction,
        runtime.config.capturePolicy
      )
      .then(() => {
        // An offscreen document that went away meanwhile took the pipeline with it.
        if (generation === offscreenGeneration) {
          detachedPipelineSids.delete(sid);
        }
      })
      .finally(() => {
        pipelineAttachments.delete(sid);
      });

    pipelineAttachments.set(sid, attachment);
    return attachment;
  }

  function markStoppedPipelinesDetached(): void {
    offscreenGeneration += 1;

    for (const runtime of deps.sessionRegistry.sidRuntimes()) {
      if (runtime.stoppedAt) {
        detachedPipelineSids.add(runtime.sid);
      }
    }
  }

  async function expireStoppedSession(sid: string): Promise<void> {
    await deps.waitForRuntimeState();
    const runtime = deps.sessionRegistry.getBySid(sid) ?? (await restoreStoppedSnapshot(sid));

    if (!runtime) {
      await forgetStoppedSession(sid);
      return;
    }

    if (runtime.stoppedAt) {
      await disposeStoppedSession(runtime);
    }
  }

  /** Rebuilds a recording whose earlier purge failed, so it can be deleted again. */
  async function restoreStoppedSnapshot(sid: string): Promise<SessionRuntime | undefined> {
    const snapshot = (await store.list()).find((row) => row.sid === sid);
    return snapshot
      ? restoreStoppedRuntime(snapshot, await deps.loadPerformanceBudgetConfig())
      : undefined;
  }

  async function retryStoppedSessionPurge(sid: string): Promise<void> {
    const attempts = await store.recordPurgeFailure(sid).catch((error) => {
      console.warn("[WebBlackbox] failed to record a recording's purge failure", error);
      return null;
    });

    if (attempts === null || attempts >= MAX_STOPPED_SESSION_PURGE_ATTEMPTS) {
      console.warn("[WebBlackbox] giving up on deleting a recording; it ends with the browser", {
        attempts
      });
      await forgetStoppedSession(sid);
      return;
    }

    detachedPipelineSids.add(sid);
    await scheduleRetentionAlarm(
      deps.alarms,
      sid,
      Date.now() + STOPPED_SESSION_PURGE_RETRY_MS
    ).catch((error) => {
      console.warn("[WebBlackbox] failed to schedule a recording's purge retry", error);
    });
  }

  function scheduleStoppedRuntimeCleanup(runtime: SessionRuntime): void {
    if (runtime.cleanupTimer !== null) {
      clearTimeout(runtime.cleanupTimer);
      runtime.cleanupTimer = null;
    }

    const expiresAt = resolveStoppedSessionExpiresAt(runtime);

    if (deps.alarms) {
      void scheduleRetentionAlarm(deps.alarms, runtime.sid, expiresAt).catch((error) => {
        console.warn("[WebBlackbox] failed to schedule the recording's retention", error);
      });
      return;
    }

    runtime.cleanupTimer = setTimeout(
      () => {
        void disposeStoppedSession(runtime);
      },
      Math.max(0, expiresAt - Date.now())
    );
  }

  function resolveStoppedSessionExpiresAt(runtime: SessionRuntime): number {
    return (runtime.stoppedAt ?? Date.now()) + resolveRuntimeStoppedSessionTtlMs(runtime);
  }

  function resolveRuntimeStoppedSessionTtlMs(runtime: SessionRuntime): number {
    return resolveStoppedSessionTtlMs(
      resolveUnexportedRetentionMs(runtime.profile.selection.profile),
      runtime.config.capturePolicy?.retention.localTtlMs
    );
  }

  async function rememberStoppedSessionRecord(runtime: SessionRuntime): Promise<void> {
    const record: StoppedSessionRecord = {
      sid: runtime.sid,
      stoppedAt: runtime.stoppedAt ?? Date.now(),
      expiresAt: resolveStoppedSessionExpiresAt(runtime)
    };

    await updateStoppedSessionRecords((records) => upsertStoppedSessionRecord(records, record));
  }

  async function forgetStoppedSessionRecord(sid: string): Promise<void> {
    await updateStoppedSessionRecords((records) => removeStoppedSessionRecord(records, sid));
  }

  function updateStoppedSessionRecords(
    update: (records: StoppedSessionRecord[]) => StoppedSessionRecord[]
  ): Promise<StoppedSessionRecord[]> {
    const task = stoppedSessionRecordsQueue.then(async () => {
      const storage = deps.localStorageArea;

      if (!storage) {
        return [];
      }

      const values = await storage.get(STOPPED_SESSIONS_STORAGE_KEY);
      const next = update(parseStoppedSessionRecords(values?.[STOPPED_SESSIONS_STORAGE_KEY]));
      await storage.set({ [STOPPED_SESSIONS_STORAGE_KEY]: next });
      return next;
    });

    stoppedSessionRecordsQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * Deletes pipeline data that no live runtime can reach any more: sessions orphaned by
   * a worker restart and stopped sessions past their retention. Runs on worker start,
   * because the per-session cleanup timers die with the previous worker.
   */
  async function sweepStalePipelineSessions(): Promise<void> {
    if (!deps.indexedDB) {
      return;
    }

    // Identity update: reads the records through the same queue as concurrent writers.
    const records = await updateStoppedSessionRecords((current) => current);
    const now = Date.now();
    const recordsBySid = new Map(records.map((record) => [record.sid, record]));
    const result = await deps.sweepStoredSessions((session) =>
      shouldSweepStoredSession({
        session,
        liveSids: new Set(deps.sessionRegistry.bySid.keys()),
        records: recordsBySid,
        now,
        bootedAt: deps.bootedAt
      })
    );
    const deletedSids = new Set(result.deleted);

    await updateStoppedSessionRecords((current) =>
      pruneStoppedSessionRecords(current, now, deletedSids)
    );

    if (result.deleted.length > 0 || result.failed.length > 0) {
      console.info("[WebBlackbox] swept stale pipeline sessions", {
        deleted: result.deleted.length,
        failed: result.failed
      });
    }
  }

  async function disposeStoppedSession(runtime: SessionRuntime): Promise<void> {
    if (!deps.sessionRegistry.hasSid(runtime.sid) || disposingSids.has(runtime.sid)) {
      return;
    }

    disposingSids.add(runtime.sid);

    try {
      await purgeStoppedSession(runtime);
    } finally {
      disposingSids.delete(runtime.sid);
    }
  }

  async function purgeStoppedSession(runtime: SessionRuntime): Promise<void> {
    if (runtime.cleanupTimer !== null) {
      clearTimeout(runtime.cleanupTimer);
      runtime.cleanupTimer = null;
    }

    await attachStoppedPipeline(runtime).catch((error) => {
      console.warn("[WebBlackbox] cannot reach a restored recording to delete it", error);
    });
    await deps.flushBufferedPipelineEvents(runtime);
    await runtime.queue;
    await runtime.pipeline.flush().catch((error) => {
      console.warn("[WebBlackbox] failed to flush a stopped recording before deletion", error);
    });
    const purged = await runtime.pipeline.close({ purge: true }).then(
      () => true,
      (error: unknown) => {
        console.warn("[WebBlackbox] failed to delete a stopped recording; retrying later", error);
        return false;
      }
    );
    deps.sessionRegistry.unregisterSid(runtime.sid);
    await forgetStoppedSessionRecord(runtime.sid).catch((error) => {
      console.warn("[WebBlackbox] failed to drop stopped session record", error);
    });

    if (purged) {
      await forgetStoppedSession(runtime.sid);
    } else {
      // The snapshot stays, so the retry (or the next worker start) can rebuild and delete it.
      await retryStoppedSessionPurge(runtime.sid);
    }

    await deps.refreshActionBadge();

    await closeOffscreenIfUnused();
    deps.pushSessionList();
    await deps.persistRuntimeState();
    deps.notifyOffscreenPipelineStatus();
  }

  async function closeOffscreenIfUnused(): Promise<void> {
    if (deps.sessionRegistry.sidCount() > 0) {
      return;
    }

    await deps.closeOffscreenDocument().catch((error) => {
      console.warn("[WebBlackbox] failed to close the offscreen document", error);
    });
  }

  return {
    rememberStoppedSession,
    forgetStoppedSession,
    toStoppedSessionSnapshot,
    restoreStoppedSessions,
    attachStoppedPipeline,
    markStoppedPipelinesDetached,
    expireStoppedSession,
    scheduleStoppedRuntimeCleanup,
    rememberStoppedSessionRecord,
    sweepStalePipelineSessions,
    disposeStoppedSession
  };
}
