import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type SessionMetadata
} from "@webblackbox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultProfile } from "../shared/profiles/presets.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";
import {
  createArea,
  createFullBodyCaptureStub,
  createHarness,
  createRuntime,
  createRuntimeInit,
  HARNESS_RETENTION_MS,
  registerStopped,
  seedSnapshots,
  snapshot,
  storedRecords,
  storedSnapshots,
  type PipelineStub
} from "./stopped-session-lifecycle-harness.js";
import { STOPPED_SESSION_PURGE_RETRY_MS } from "./stopped-session-lifecycle.js";
import { retentionAlarmName } from "./stopped-session-store.js";
import {
  KEPT_UNTIL_EXPORTED_EXPIRES_AT,
  STOPPED_SESSIONS_STORAGE_KEY,
  type StoppedSessionRecord
} from "./stopped-sessions.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("toStoppedSessionSnapshot", () => {
  it("copies every field a later worker needs to rebuild the session", () => {
    const { lifecycle } = createHarness();
    const profileRetentionMs = HARNESS_RETENTION_MS;
    const cancellation = {
      reason: "rule-changed" as const,
      trigger: "navigation" as const,
      at: 1_500,
      started: { id: "builtin:qa", name: "QA", source: "rule" as const, extended: false }
    };
    const init = createRuntimeInit({ sid: "S-1", stoppedAt: 2_000 });
    const runtime = createSessionRuntime(
      {
        ...init,
        profile: { ...init.profile, cancellation }
      },
      { createFullBodyCapture: () => createFullBodyCaptureStub() }
    );
    runtime.capturedEventCount = 12;
    runtime.capturedErrorCount = 1;
    runtime.capturedSizeBytes = 4_096;
    runtime.budgetAlertCount = 2;

    const result = lifecycle.toStoppedSessionSnapshot(runtime);

    expect(result.sid).toBe("S-1");
    expect(result.tabId).toBe(7);
    expect(result.mode).toBe("lite");
    expect(result.startedAt).toBe(1_000);
    expect(result.stoppedAt).toBe(2_000);
    expect(result.expiresAt).toBe(2_000 + profileRetentionMs);
    expect(result.url).toBe("https://example.test/app");
    expect(result.title).toBe("Example");
    expect(result.profile.request).toBe("auto");
    expect(result.profile.visualCapture).toBeUndefined();
    expect(result.profile.selection).toBe(init.profile.selection);
    expect(result.profile.profileConfig).toBe(DEFAULT_RECORDER_CONFIG);
    expect(result.profile.visualsCaptured).toEqual({ screenshots: true, screenRecordings: false });
    expect(result.profile.cancellation).toEqual(cancellation);
    expect(result.profile.cancellationAcknowledged).toBe(false);
    expect(result.config).toBe(DEFAULT_RECORDER_CONFIG);
    expect(result.counters).toEqual({
      eventCount: 12,
      errorCount: 1,
      sizeBytes: 4_096,
      budgetAlertCount: 2
    });
    expect(result.purgeAttempts).toBeUndefined();
  });

  it("caps the stopped-session TTL at the capture policy's local retention", () => {
    const { lifecycle } = createHarness();
    const runtime = createRuntime({
      stoppedAt: 2_000,
      config: {
        ...DEFAULT_RECORDER_CONFIG,
        capturePolicy: { ...DEFAULT_CAPTURE_POLICY, retention: { localTtlMs: 60_000 } }
      }
    });

    expect(lifecycle.toStoppedSessionSnapshot(runtime).expiresAt).toBe(62_000);
  });

  it("stamps stoppedAt for a runtime that has none yet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const { lifecycle } = createHarness();
    const profileRetentionMs = HARNESS_RETENTION_MS;

    const result = lifecycle.toStoppedSessionSnapshot(createRuntime());

    expect(result.stoppedAt).toBe(50_000);
    expect(result.expiresAt).toBe(50_000 + profileRetentionMs);
  });
});

describe("rememberStoppedSession / forgetStoppedSession", () => {
  it("round-trips the snapshot through the storage.session area", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness);

    await harness.lifecycle.rememberStoppedSession(runtime);

    expect(storedSnapshots(harness.sessionArea)).toEqual([
      JSON.parse(JSON.stringify(harness.lifecycle.toStoppedSessionSnapshot(runtime)))
    ]);

    await harness.lifecycle.rememberStoppedSession(runtime);
    expect(storedSnapshots(harness.sessionArea)).toHaveLength(1);
  });

  it("keeps nothing for a runtime still recording or unknown to the registry", async () => {
    const harness = createHarness();

    await harness.lifecycle.rememberStoppedSession(createRuntime());
    await harness.lifecycle.rememberStoppedSession(
      createRuntime({ sid: "S-gone", stoppedAt: 2_000 })
    );

    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
  });

  it("forgets the snapshot and clears the retention alarm", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness);
    await harness.lifecycle.rememberStoppedSession(runtime);

    await harness.lifecycle.forgetStoppedSession("S-1");

    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
    expect(harness.alarms.clear).toHaveBeenCalledWith(retentionAlarmName("S-1"));
  });

  it("warns instead of failing when the retention alarm cannot be cleared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    harness.alarms.clear.mockRejectedValueOnce(new Error("alarms unavailable"));

    await harness.lifecycle.forgetStoppedSession("S-1");

    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] failed to clear a stopped recording's retention alarm",
      expect.any(Error)
    );
  });
});

describe("restoreStoppedSessions", () => {
  it("restores kept recordings by sid, keeps their counters and schedules their retention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const harness = createHarness();
    harness.getSessionAnnotation.mockReturnValue({ tags: ["tag-a"], note: "note" });
    seedSnapshots(harness.sessionArea, [snapshot("S-kept", { expiresAt: 999_999 })]);

    await harness.lifecycle.restoreStoppedSessions();

    const runtime = harness.registry.getBySid("S-kept");
    const profileRetentionMs = HARNESS_RETENTION_MS;
    expect(runtime).toBeDefined();
    expect(harness.registry.getByTab(7)).toBeUndefined();
    expect(runtime?.stoppedAt).toBe(2_000);
    expect(runtime?.capturedEventCount).toBe(12);
    expect(runtime?.capturedErrorCount).toBe(1);
    expect(runtime?.capturedSizeBytes).toBe(4_096);
    expect(runtime?.budgetAlertCount).toBe(2);
    expect(runtime?.tags).toEqual(["tag-a"]);
    expect(runtime?.note).toBe("note");
    expect(harness.alarms.create).toHaveBeenCalledWith(retentionAlarmName("S-kept"), {
      when: 2_000 + profileRetentionMs
    });

    // The restored pipeline is detached: the first attach starts it, the second is a no-op.
    await harness.lifecycle.attachStoppedPipeline(runtime as SessionRuntime);
    await harness.lifecycle.attachStoppedPipeline(runtime as SessionRuntime);
    expect(harness.pipelines.get("S-kept")?.start).toHaveBeenCalledTimes(1);
  });

  it("purges expired recordings at worker start and forgets their snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    const harness = createHarness();
    seedSnapshots(harness.sessionArea, [snapshot("S-expired", { expiresAt: 400_000 })]);

    await harness.lifecycle.restoreStoppedSessions();

    const pipeline = harness.pipelines.get("S-expired");
    expect(pipeline?.close).toHaveBeenCalledWith({ purge: true });
    expect(harness.registry.getBySid("S-expired")).toBeUndefined();
    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
    expect(harness.alarms.clear).toHaveBeenCalledWith(retentionAlarmName("S-expired"));
    expect(harness.flushBufferedPipelineEvents).toHaveBeenCalledTimes(1);
    expect(harness.refreshActionBadge).toHaveBeenCalledTimes(1);
    expect(harness.pushSessionList).toHaveBeenCalledTimes(1);
    expect(harness.persistRuntimeState).toHaveBeenCalledTimes(1);
    expect(harness.notifyOffscreenPipelineStatus).toHaveBeenCalledTimes(1);
    // The last session is gone: the offscreen document is closed once.
    expect(harness.closeOffscreenDocument).toHaveBeenCalledTimes(1);
  });

  it("reschedules recordings whose purge already failed and leaves them unrestored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    const harness = createHarness();
    seedSnapshots(harness.sessionArea, [
      snapshot("S-retrying", { expiresAt: 400_000, purgeAttempts: 1 })
    ]);

    await harness.lifecycle.restoreStoppedSessions();

    expect(harness.registry.getBySid("S-retrying")).toBeUndefined();
    expect(harness.alarms.create).toHaveBeenCalledWith(retentionAlarmName("S-retrying"), {
      when: 500_000 + STOPPED_SESSION_PURGE_RETRY_MS
    });
    expect(storedSnapshots(harness.sessionArea)).toHaveLength(1);
    expect(harness.pipelines.has("S-retrying")).toBe(false);
  });

  it("clears the store and restores nothing under a freshly minted key", async () => {
    const harness = createHarness({
      isAtRestKeyFresh: () => true
    });
    seedSnapshots(harness.sessionArea, [snapshot("S-kept", { expiresAt: 999_999 })]);

    await harness.lifecycle.restoreStoppedSessions();

    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
    expect(harness.registry.sidCount()).toBe(0);
  });

  it("restores nothing when the at-rest key is unavailable", async () => {
    const harness = createHarness({
      getAtRestKey: vi.fn(async () => {
        throw new Error("no key");
      })
    });
    seedSnapshots(harness.sessionArea, [snapshot("S-kept", { expiresAt: 999_999 })]);

    await harness.lifecycle.restoreStoppedSessions();

    expect(storedSnapshots(harness.sessionArea)).toHaveLength(1);
    expect(harness.registry.sidCount()).toBe(0);
  });

  it("does nothing without snapshots", async () => {
    const harness = createHarness();

    await harness.lifecycle.restoreStoppedSessions();

    expect(harness.loadPerformanceBudgetConfig).not.toHaveBeenCalled();
    expect(harness.registry.sidCount()).toBe(0);
  });
});

describe("attachStoppedPipeline / markStoppedPipelinesDetached", () => {
  it("keeps a pipeline detached when the offscreen document was replaced mid-attach", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness);
    harness.lifecycle.markStoppedPipelinesDetached();

    let resolveStart: (() => void) | undefined;
    const pipeline = runtime.pipeline as PipelineStub;
    pipeline.start
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          })
      )
      .mockResolvedValue(undefined);

    const first = harness.lifecycle.attachStoppedPipeline(runtime);
    harness.lifecycle.markStoppedPipelinesDetached();
    resolveStart?.();
    await first;

    await harness.lifecycle.attachStoppedPipeline(runtime);
    expect(pipeline.start).toHaveBeenCalledTimes(2);
  });

  it("attaches once while the offscreen document stays put", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness);
    harness.lifecycle.markStoppedPipelinesDetached();

    await harness.lifecycle.attachStoppedPipeline(runtime);
    await harness.lifecycle.attachStoppedPipeline(runtime);

    expect(runtime.pipeline.start).toHaveBeenCalledTimes(1);
    expect(runtime.pipeline.start).toHaveBeenCalledWith(
      expect.objectContaining({ sid: "S-1" }),
      runtime.config.redaction,
      runtime.config.capturePolicy
    );
  });

  it("marks only stopped runtimes as detached", async () => {
    const harness = createHarness();
    const active = createRuntime({ sid: "S-active" });
    harness.registry.register(active);
    registerStopped(harness, { sid: "S-stopped", tabId: 9 });

    harness.lifecycle.markStoppedPipelinesDetached();

    await harness.lifecycle.attachStoppedPipeline(active);
    expect(active.pipeline.start).not.toHaveBeenCalled();
  });
});

describe("expireStoppedSession / scheduleStoppedRuntimeCleanup", () => {
  it("falls back to a timer without chrome.alarms and disposes the recording at its TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const harness = createHarness({ alarms: undefined });
    const runtime = registerStopped(harness);

    harness.lifecycle.scheduleStoppedRuntimeCleanup(runtime);
    expect(runtime.cleanupTimer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(HARNESS_RETENTION_MS);

    expect(runtime.pipeline.close).toHaveBeenCalledWith({ purge: true });
    expect(harness.registry.getBySid("S-1")).toBeUndefined();
    expect(runtime.cleanupTimer).toBeNull();
  });

  it("keeps a recording without a retention until it is exported or deleted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const keptProfile = createDefaultProfile();
    const withTimer = createHarness({ alarms: undefined });
    const timerless = registerStopped(withTimer, {
      profile: {
        ...createRuntimeInit().profile,
        selection: { profile: keptProfile, source: "default", extended: false }
      }
    });
    const withAlarms = createHarness();
    const alarmless = registerStopped(withAlarms, {
      profile: {
        ...createRuntimeInit().profile,
        selection: { profile: keptProfile, source: "default", extended: false }
      }
    });

    withTimer.lifecycle.scheduleStoppedRuntimeCleanup(timerless);
    withAlarms.lifecycle.scheduleStoppedRuntimeCleanup(alarmless);
    await withAlarms.lifecycle.rememberStoppedSessionRecord(alarmless);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(timerless.cleanupTimer).toBeNull();
    expect(timerless.pipeline.close).not.toHaveBeenCalled();
    expect(withAlarms.alarms.create).not.toHaveBeenCalled();
    expect(withAlarms.alarms.clear).toHaveBeenCalledWith(retentionAlarmName("S-1"));
    expect(storedRecords(withAlarms.localArea)).toEqual([
      { sid: "S-1", stoppedAt: 2_000, expiresAt: KEPT_UNTIL_EXPORTED_EXPIRES_AT }
    ]);
  });

  it("re-scheduling replaces a pending timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const harness = createHarness({ alarms: undefined });
    const runtime = registerStopped(harness);

    harness.lifecycle.scheduleStoppedRuntimeCleanup(runtime);
    const first = runtime.cleanupTimer;
    harness.lifecycle.scheduleStoppedRuntimeCleanup(runtime);

    expect(runtime.cleanupTimer).not.toBe(first);
    await vi.advanceTimersByTimeAsync(HARNESS_RETENTION_MS);
    expect(runtime.pipeline.close).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a recording from its snapshot when the alarm fires after a restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    const harness = createHarness();
    seedSnapshots(harness.sessionArea, [snapshot("S-1", { expiresAt: 400_000 })]);

    await harness.lifecycle.expireStoppedSession("S-1");

    expect(harness.loadPerformanceBudgetConfig).toHaveBeenCalled();
    expect(harness.pipelines.get("S-1")?.close).toHaveBeenCalledWith({ purge: true });
    expect(harness.registry.getBySid("S-1")).toBeUndefined();
    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
  });

  it("forgets a sid that has neither runtime nor snapshot", async () => {
    const harness = createHarness();

    await harness.lifecycle.expireStoppedSession("S-gone");

    expect(harness.alarms.clear).toHaveBeenCalledWith(retentionAlarmName("S-gone"));
  });

  it("leaves a runtime that is still recording alone", async () => {
    const harness = createHarness();
    const runtime = createRuntime();
    harness.registry.register(runtime);

    await harness.lifecycle.expireStoppedSession("S-1");

    expect(runtime.pipeline.close).not.toHaveBeenCalled();
    expect(harness.registry.getBySid("S-1")).toBe(runtime);
  });
});

describe("disposeStoppedSession / purge", () => {
  it("runs the full purge path and closes the offscreen document once unused", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness);
    await harness.lifecycle.rememberStoppedSession(runtime);
    await harness.lifecycle.rememberStoppedSessionRecord(runtime);

    await harness.lifecycle.disposeStoppedSession(runtime);

    const pipeline = runtime.pipeline as PipelineStub;
    expect(pipeline.flush).toHaveBeenCalledTimes(1);
    expect(pipeline.close).toHaveBeenCalledWith({ purge: true });
    expect(harness.flushBufferedPipelineEvents).toHaveBeenCalledWith(runtime);
    expect(harness.registry.getBySid("S-1")).toBeUndefined();
    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
    expect(storedRecords(harness.localArea)).toEqual([]);
    expect(harness.alarms.clear).toHaveBeenCalledWith(retentionAlarmName("S-1"));
    expect(harness.refreshActionBadge).toHaveBeenCalledTimes(1);
    expect(harness.closeOffscreenDocument).toHaveBeenCalledTimes(1);
    expect(harness.pushSessionList).toHaveBeenCalledTimes(1);
    expect(harness.persistRuntimeState).toHaveBeenCalledTimes(1);
    expect(harness.notifyOffscreenPipelineStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps the offscreen document while other sessions remain", async () => {
    const harness = createHarness();
    registerStopped(harness, { sid: "S-other", tabId: 9 });
    const runtime = registerStopped(harness);

    await harness.lifecycle.disposeStoppedSession(runtime);

    expect(harness.closeOffscreenDocument).not.toHaveBeenCalled();
  });

  it("ignores a runtime the registry no longer holds", async () => {
    const harness = createHarness();
    const runtime = createRuntime({ stoppedAt: 2_000 });

    await harness.lifecycle.disposeStoppedSession(runtime);

    expect(runtime.pipeline.close).not.toHaveBeenCalled();
  });

  it("runs concurrent disposals of one session only once", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness);
    const pipeline = runtime.pipeline as PipelineStub;
    let resolveClose: (() => void) | undefined;
    pipeline.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        })
    );

    const first = harness.lifecycle.disposeStoppedSession(runtime);
    const second = harness.lifecycle.disposeStoppedSession(runtime);
    await vi.waitFor(() => {
      expect(resolveClose).toBeDefined();
    });
    resolveClose?.();
    await Promise.all([first, second]);

    expect(pipeline.close).toHaveBeenCalledTimes(1);
  });

  it("schedules a retry when the purge fails and keeps the snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    const runtime = registerStopped(harness);
    await harness.lifecycle.rememberStoppedSession(runtime);
    (runtime.pipeline as PipelineStub).close.mockRejectedValue(new Error("offscreen gone"));

    await harness.lifecycle.disposeStoppedSession(runtime);

    expect(harness.alarms.create).toHaveBeenCalledWith(retentionAlarmName("S-1"), {
      when: 10_000 + STOPPED_SESSION_PURGE_RETRY_MS
    });
    expect(storedSnapshots(harness.sessionArea)).toEqual([
      expect.objectContaining({ sid: "S-1", purgeAttempts: 1 })
    ]);
    expect(harness.registry.getBySid("S-1")).toBeUndefined();
  });

  it("gives up after the third failed purge and forgets the recording", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    seedSnapshots(harness.sessionArea, [snapshot("S-1", { purgeAttempts: 2 })]);
    const runtime = registerStopped(harness);
    (runtime.pipeline as PipelineStub).close.mockRejectedValue(new Error("offscreen gone"));

    await harness.lifecycle.disposeStoppedSession(runtime);

    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] giving up on deleting a recording; it ends with the browser",
      { attempts: 3 }
    );
    expect(harness.alarms.create).not.toHaveBeenCalled();
    expect(harness.alarms.clear).toHaveBeenCalledWith(retentionAlarmName("S-1"));
    expect(storedSnapshots(harness.sessionArea)).toEqual([]);
  });
});

describe("stopped session records", () => {
  it("writes sid, stoppedAt and expiresAt through the serialized queue", async () => {
    const localArea = createArea({ delayed: true });
    const harness = createHarness({ localStorageArea: localArea });
    const profileRetentionMs = HARNESS_RETENTION_MS;

    await Promise.all([
      harness.lifecycle.rememberStoppedSessionRecord(registerStopped(harness, { sid: "S-1" })),
      harness.lifecycle.rememberStoppedSessionRecord(
        registerStopped(harness, { sid: "S-2", tabId: 8 })
      ),
      harness.lifecycle.rememberStoppedSessionRecord(
        registerStopped(harness, { sid: "S-3", tabId: 9 })
      )
    ]);

    expect(storedRecords(localArea)).toEqual(
      ["S-1", "S-2", "S-3"].map((sid) => ({
        sid,
        stoppedAt: 2_000,
        expiresAt: 2_000 + profileRetentionMs
      }))
    );
  });

  it("keeps no records without a local storage area", async () => {
    const harness = createHarness({ localStorageArea: undefined });

    await harness.lifecycle.rememberStoppedSessionRecord(registerStopped(harness));

    // The sweep reads through the same queue: without an area it sees no records.
    await harness.lifecycle.sweepStalePipelineSessions();
    expect(harness.sweepStoredSessions).not.toHaveBeenCalled();
  });
});

describe("sweepStalePipelineSessions", () => {
  it("does nothing without IndexedDB", async () => {
    const harness = createHarness({ indexedDB: undefined });

    await harness.lifecycle.sweepStalePipelineSessions();

    expect(harness.sweepStoredSessions).not.toHaveBeenCalled();
  });

  it("sweeps orphaned and expired sessions, then prunes their records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const harness = createHarness({ indexedDB: {} as IDBFactory });
    harness.registry.registerBySid(createRuntime({ sid: "S-live" }));
    const records: StoppedSessionRecord[] = [
      { sid: "S-expired", stoppedAt: 1_000, expiresAt: 5_000 },
      { sid: "S-kept", stoppedAt: 1_000, expiresAt: 900_000 }
    ];
    await harness.localArea.set({ [STOPPED_SESSIONS_STORAGE_KEY]: records });
    const storedSessions: SessionMetadata[] = [
      {
        sid: "S-expired",
        tabId: 1,
        startedAt: 50_000,
        mode: "lite",
        url: "https://a.test",
        tags: []
      },
      {
        sid: "S-orphan",
        tabId: 2,
        startedAt: 50_000,
        mode: "lite",
        url: "https://b.test",
        tags: []
      },
      { sid: "S-kept", tabId: 3, startedAt: 50_000, mode: "lite", url: "https://c.test", tags: [] },
      { sid: "S-live", tabId: 4, startedAt: 50_000, mode: "lite", url: "https://d.test", tags: [] },
      {
        sid: "S-fresh",
        tabId: 5,
        startedAt: 150_000,
        mode: "lite",
        url: "https://e.test",
        tags: []
      }
    ];
    harness.sweepStoredSessions.mockImplementation(
      async (shouldDelete: (session: SessionMetadata) => boolean) => ({
        deleted: storedSessions.filter(shouldDelete).map((session) => session.sid),
        failed: []
      })
    );

    await harness.lifecycle.sweepStalePipelineSessions();

    expect(harness.sweepStoredSessions).toHaveBeenCalledTimes(1);
    expect(storedRecords(harness.localArea)).toEqual([
      { sid: "S-kept", stoppedAt: 1_000, expiresAt: 900_000 }
    ]);
  });
});
