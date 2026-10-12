import type { SessionMetadata } from "@webblackbox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LIVE_SESSION_SNAPSHOTS_KEY } from "./live-session-store.js";
import type { SessionRuntime } from "./session-registry.js";
import {
  createHarness,
  createRuntime,
  HARNESS_RETENTION_MS,
  liveSnapshot,
  registerStopped,
  seedSnapshots,
  snapshot,
  storedLiveSnapshots,
  storedRecords,
  storedSnapshots
} from "./stopped-session-lifecycle-harness.js";
import { retentionAlarmName, STOPPED_SESSION_SNAPSHOTS_KEY } from "./stopped-session-store.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("interrupted recordings", () => {
  it("checkpoints a running recording at most every few seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const harness = createHarness();
    const runtime = createRuntime({ sid: "S-live" });
    harness.registry.registerBySid(runtime);

    await harness.lifecycle.rememberLiveSession(runtime);
    runtime.capturedEventCount = 5;
    vi.setSystemTime(55_000);
    harness.lifecycle.checkpointLiveSession(runtime);
    await vi.runAllTimersAsync();

    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([
      expect.objectContaining({ sid: "S-live", lastSeenAt: 50_000 })
    ]);

    vi.setSystemTime(61_000);
    harness.lifecycle.checkpointLiveSession(runtime);
    await vi.runAllTimersAsync();

    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([
      expect.objectContaining({
        sid: "S-live",
        lastSeenAt: 61_000,
        counters: expect.objectContaining({ eventCount: 5 })
      })
    ]);

    await harness.lifecycle.forgetLiveSession("S-live");
    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([]);
  });

  it("does not checkpoint a stopped recording", async () => {
    const harness = createHarness();
    const runtime = registerStopped(harness, { sid: "S-stopped" });

    await harness.lifecycle.rememberLiveSession(runtime);

    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([]);
  });

  it("keeps a recording an earlier worker left running as interrupted and exportable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    const harness = createHarness({ indexedDB: {} as IDBFactory });
    const profileRetentionMs = HARNESS_RETENTION_MS;
    await harness.sessionArea.set({
      [LIVE_SESSION_SNAPSHOTS_KEY]: [liveSnapshot("S-crashed", 80_000)]
    });

    await harness.lifecycle.restoreStoppedSessions();

    const runtime = harness.registry.getBySid("S-crashed");
    const interruption = {
      reason: "service-worker-restart",
      detectedAt: 90_000,
      lastSeenAt: 80_000
    };
    expect(runtime?.stoppedAt).toBe(80_000);
    expect(runtime?.interruption).toEqual(interruption);
    expect(runtime?.capturedEventCount).toBe(12);
    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([]);
    expect(storedSnapshots(harness.sessionArea)).toEqual([
      expect.objectContaining({
        sid: "S-crashed",
        stoppedAt: 80_000,
        expiresAt: 80_000 + profileRetentionMs,
        interruption
      })
    ]);
    expect(storedRecords(harness.localArea)).toEqual([
      { sid: "S-crashed", stoppedAt: 80_000, expiresAt: 80_000 + profileRetentionMs }
    ]);
    expect(harness.alarms.create).toHaveBeenCalledWith(retentionAlarmName("S-crashed"), {
      when: 80_000 + profileRetentionMs
    });

    // Its stored data is kept by the sweep that follows at worker start.
    harness.sweepStoredSessions.mockImplementation(
      async (shouldDelete: (session: SessionMetadata) => boolean) => ({
        deleted: (
          [
            { sid: "S-crashed", tabId: 7, startedAt: 1_000, mode: "lite", url: "u", tags: [] }
          ] satisfies SessionMetadata[]
        )
          .filter(shouldDelete)
          .map((session) => session.sid),
        failed: []
      })
    );
    await harness.lifecycle.sweepStalePipelineSessions();
    expect(storedRecords(harness.localArea)).toHaveLength(1);

    // Exported like a stopped recording: its pipeline is attached on demand.
    expect(runtime).toBeDefined();
    await harness.lifecycle.attachStoppedPipeline(runtime as SessionRuntime);
    expect(harness.pipelines.get("S-crashed")?.start).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.toStoppedSessionSnapshot(runtime as SessionRuntime)).toMatchObject({
      interruption
    });
  });

  it("keeps the data of an interrupted recording it failed to keep, for the next worker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness({ indexedDB: {} as IDBFactory });
    await harness.sessionArea.set({
      [LIVE_SESSION_SNAPSHOTS_KEY]: [
        liveSnapshot("S-failed", 70_000),
        liveSnapshot("S-kept", 80_000)
      ]
    });
    const set = vi.mocked(harness.sessionArea.set);
    const write = set.getMockImplementation();
    let failures = 1;
    set.mockImplementation(async (items: Record<string, unknown>) => {
      if (STOPPED_SESSION_SNAPSHOTS_KEY in items && failures > 0) {
        failures -= 1;
        throw new Error("quota");
      }

      await write?.(items);
    });

    await harness.lifecycle.restoreStoppedSessions();

    expect(harness.registry.getBySid("S-failed")).toBeUndefined();
    expect(harness.registry.getBySid("S-kept")?.interruption).toMatchObject({
      reason: "service-worker-restart"
    });
    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([
      expect.objectContaining({ sid: "S-failed" })
    ]);

    const stored = (["S-failed", "S-kept", "S-orphan"] as const).map((sid): SessionMetadata => ({
      sid,
      tabId: 7,
      startedAt: 1_000,
      mode: "lite",
      url: "u",
      tags: []
    }));
    harness.sweepStoredSessions.mockImplementation(
      async (shouldDelete: (session: SessionMetadata) => boolean) => ({
        deleted: stored.filter(shouldDelete).map((session) => session.sid),
        failed: []
      })
    );
    await harness.lifecycle.sweepStalePipelineSessions();

    const sweep = harness.sweepStoredSessions.mock.calls[0]?.[0] as (
      session: SessionMetadata
    ) => boolean;
    expect(stored.filter(sweep).map((session) => session.sid)).toEqual(["S-orphan"]);
  });

  it("sweeps a checkpointed recording it never managed to keep once its retention is over", async () => {
    const retentionMs = HARNESS_RETENTION_MS;
    vi.useFakeTimers();
    vi.setSystemTime(80_000 + retentionMs + 1);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness({ indexedDB: {} as IDBFactory });
    await harness.sessionArea.set({
      [LIVE_SESSION_SNAPSHOTS_KEY]: [liveSnapshot("S-stuck", 80_000)]
    });
    const set = vi.mocked(harness.sessionArea.set);
    const write = set.getMockImplementation();
    set.mockImplementation(async (items: Record<string, unknown>) => {
      if (STOPPED_SESSION_SNAPSHOTS_KEY in items) {
        throw new Error("quota");
      }

      await write?.(items);
    });

    await harness.lifecycle.restoreStoppedSessions();
    await harness.lifecycle.sweepStalePipelineSessions();

    expect(storedLiveSnapshots(harness.sessionArea)).toHaveLength(1);
    const sweep = harness.sweepStoredSessions.mock.calls[0]?.[0] as (
      session: SessionMetadata
    ) => boolean;
    expect(
      sweep({ sid: "S-stuck", tabId: 7, startedAt: 1_000, mode: "lite", url: "u", tags: [] })
    ).toBe(true);
  });

  it("drops the checkpoint of a recording that stopped before it was forgotten", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    const harness = createHarness();
    seedSnapshots(harness.sessionArea, [snapshot("S-stopped", { expiresAt: 999_999 })]);
    await harness.sessionArea.set({
      [LIVE_SESSION_SNAPSHOTS_KEY]: [liveSnapshot("S-stopped", 1_500)]
    });

    await harness.lifecycle.restoreStoppedSessions();

    expect(harness.registry.getBySid("S-stopped")?.interruption).toBeUndefined();
    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([]);
  });

  it("leaves the checkpoint of a recording this worker runs", async () => {
    const harness = createHarness();
    harness.registry.registerBySid(createRuntime({ sid: "S-mine" }));
    await harness.sessionArea.set({
      [LIVE_SESSION_SNAPSHOTS_KEY]: [liveSnapshot("S-mine", 1_500)]
    });

    await harness.lifecycle.restoreStoppedSessions();

    expect(storedLiveSnapshots(harness.sessionArea)).toHaveLength(1);
    expect(harness.registry.getBySid("S-mine")?.stoppedAt).toBeUndefined();
  });

  it("clears the checkpoints under a freshly minted key", async () => {
    const harness = createHarness({ isAtRestKeyFresh: () => true });
    await harness.sessionArea.set({
      [LIVE_SESSION_SNAPSHOTS_KEY]: [liveSnapshot("S-gone", 1_500)]
    });

    await harness.lifecycle.restoreStoppedSessions();

    expect(storedLiveSnapshots(harness.sessionArea)).toEqual([]);
    expect(harness.registry.sidCount()).toBe(0);
  });
});
