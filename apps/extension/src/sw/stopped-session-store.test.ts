import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import { createDefaultProfile } from "../shared/profiles/presets.js";
import { resolveUnexportedRetentionMs } from "../shared/profiles/local-data.js";
import { findBuiltInProfile } from "../shared/profiles/presets.js";
import {
  clearRetentionAlarm,
  createStoppedSessionStore,
  MAX_STOPPED_SESSION_SNAPSHOTS,
  parseStoppedSessionSnapshots,
  planStoppedSessionRestore,
  retentionAlarmName,
  scheduleRetentionAlarm,
  sidFromRetentionAlarm,
  type SnapshotStorageAreaLike,
  type StoppedSessionSnapshot
} from "./stopped-session-store.js";

function snapshot(
  sid: string,
  overrides: Partial<StoppedSessionSnapshot> = {}
): StoppedSessionSnapshot {
  const selection = {
    profile: createDefaultProfile(),
    source: "default" as const,
    extended: false,
    legacy: false
  };

  return {
    sid,
    tabId: 7,
    mode: "lite",
    startedAt: 1_000,
    stoppedAt: 2_000,
    expiresAt: 602_000,
    url: "https://example.test/",
    title: "Example",
    profile: {
      request: "auto",
      selection,
      history: [selection],
      visualsCaptured: { screenshots: false, screenRecordings: false }
    },
    config: DEFAULT_RECORDER_CONFIG,
    counters: { eventCount: 12, errorCount: 1, sizeBytes: 4_096, budgetAlertCount: 0 },
    purgeAttempts: 0,
    ...overrides
  };
}

/** Stores JSON, as `chrome.storage.session` does. */
function createArea(): SnapshotStorageAreaLike {
  let stored: Record<string, string> = {};

  return {
    get: vi.fn(async (key: string) => {
      const value = stored[key];
      return value === undefined ? {} : { [key]: JSON.parse(value) as unknown };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      stored = {
        ...stored,
        ...Object.fromEntries(
          Object.entries(items).map(([key, value]) => [key, JSON.stringify(value)])
        )
      };
    })
  };
}

describe("stopped session store", () => {
  it("keeps a stopped recording restorable across a worker restart", async () => {
    const area = createArea();
    await createStoppedSessionStore(area).remember(snapshot("S-1"));

    // A new worker builds a new store over the same storage.session area.
    const restored = await createStoppedSessionStore(area).list();

    expect(restored).toEqual([JSON.parse(JSON.stringify(snapshot("S-1")))]);
  });

  it("replaces a snapshot of the same session and forgets it on disposal", async () => {
    const store = createStoppedSessionStore(createArea());

    await store.remember(snapshot("S-1"));
    await store.remember(snapshot("S-2"));
    await store.remember(snapshot("S-1", { expiresAt: 900_000 }));
    expect((await store.list()).map((row) => [row.sid, row.expiresAt])).toEqual([
      ["S-2", 602_000],
      ["S-1", 900_000]
    ]);

    await store.forget("S-1");
    expect((await store.list()).map((row) => row.sid)).toEqual(["S-2"]);

    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it("serializes concurrent writes", async () => {
    const store = createStoppedSessionStore(createArea());

    await Promise.all(["S-1", "S-2", "S-3"].map((sid) => store.remember(snapshot(sid))));

    expect((await store.list()).map((row) => row.sid)).toEqual(["S-1", "S-2", "S-3"]);
  });

  it("keeps nothing without a storage area", async () => {
    const store = createStoppedSessionStore(undefined);

    await store.remember(snapshot("S-1"));

    expect(await store.list()).toEqual([]);
  });

  it("drops malformed snapshots and caps how many are kept", () => {
    const many = Array.from({ length: MAX_STOPPED_SESSION_SNAPSHOTS + 5 }, (_, index) =>
      snapshot(`S-${index}`)
    );
    const parsed = parseStoppedSessionSnapshots([
      ...many,
      { ...snapshot("S-bad-mode"), mode: "other" },
      { ...snapshot("S-bad-time"), expiresAt: 1 },
      { ...snapshot("S-no-config"), config: null },
      "junk"
    ]);

    expect(parsed).toHaveLength(MAX_STOPPED_SESSION_SNAPSHOTS);
    expect(parsed[0]?.sid).toBe("S-5");
    expect(parseStoppedSessionSnapshots({ not: "a list" })).toEqual([]);
    expect(
      parseStoppedSessionSnapshots([{ ...snapshot("S-1"), counters: undefined }])[0]?.counters
    ).toEqual({ eventCount: 0, errorCount: 0, sizeBytes: 0, budgetAlertCount: 0 });
  });
});

describe("retention", () => {
  it("restores recordings inside their retention and purges the expired ones at worker start", () => {
    const kept = snapshot("S-kept", { expiresAt: 10_000 });
    const expired = snapshot("S-expired", { expiresAt: 5_000 });
    const retrying = snapshot("S-retrying", { expiresAt: 4_000, purgeAttempts: 1 });

    expect(planStoppedSessionRestore([kept, expired, retrying], 5_000)).toEqual({
      kept: [kept],
      purgeNow: [expired],
      purgeLater: [retrying]
    });
  });

  it("counts failed purges of a snapshot and reports a missing one", async () => {
    const store = createStoppedSessionStore(createArea());
    await store.remember(snapshot("S-1"));

    await expect(store.recordPurgeFailure("S-1")).resolves.toBe(1);
    await expect(store.recordPurgeFailure("S-1")).resolves.toBe(2);
    await expect(store.recordPurgeFailure("S-missing")).resolves.toBeNull();
    expect((await store.list())[0]?.purgeAttempts).toBe(2);
  });

  it("names one alarm per recording and reads the session back from it", () => {
    expect(retentionAlarmName("S-1")).toBe("webblackbox.retention:S-1");
    expect(sidFromRetentionAlarm(retentionAlarmName("S-1"))).toBe("S-1");
    expect(sidFromRetentionAlarm("webblackbox.retention:")).toBeNull();
    expect(sidFromRetentionAlarm("other-alarm")).toBeNull();
  });

  it("schedules one persisted alarm at the profile's retention and clears it on disposal", async () => {
    const alarms = { create: vi.fn(), clear: vi.fn(async () => true) };
    const fullCapture = findBuiltInProfile("builtin:full-capture");
    expect(fullCapture).toBeDefined();
    const expiresAt = 2_000 + resolveUnexportedRetentionMs(fullCapture ?? createDefaultProfile());

    await expect(scheduleRetentionAlarm(alarms, "S-1", expiresAt)).resolves.toBe(true);
    await clearRetentionAlarm(alarms, "S-1");

    expect(expiresAt).toBe(2_000 + 5 * 60_000);
    expect(alarms.create).toHaveBeenCalledWith("webblackbox.retention:S-1", { when: expiresAt });
    expect(alarms.clear).toHaveBeenCalledWith("webblackbox.retention:S-1");
  });

  it("tells the caller to fall back to a timer without chrome.alarms", async () => {
    await expect(scheduleRetentionAlarm(undefined, "S-1", 1)).resolves.toBe(false);
    await expect(clearRetentionAlarm(undefined, "S-1")).resolves.toBeUndefined();
  });
});
