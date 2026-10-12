import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  createLiveSessionStore,
  LIVE_SESSION_SNAPSHOTS_KEY,
  parseLiveSessionSnapshots,
  toInterruptedSnapshot,
  type LiveSessionSnapshot
} from "./live-session-store.js";
import type { SnapshotStorageAreaLike } from "./stopped-session-store.js";

function live(sid: string, lastSeenAt = 5_000): LiveSessionSnapshot {
  return {
    sid,
    tabId: 7,
    mode: "full",
    startedAt: 1_000,
    url: "https://example.test/",
    title: "Example",
    profile: {
      request: "auto",
      selection: { profile: createDefaultProfile(), source: "default", extended: false },
      profileConfig: DEFAULT_RECORDER_CONFIG,
      visualsCaptured: { screenshots: true, screenRecordings: false }
    },
    config: DEFAULT_RECORDER_CONFIG,
    counters: { eventCount: 40, errorCount: 2, sizeBytes: 9_000, budgetAlertCount: 0 },
    lastSeenAt
  };
}

/** Stores JSON, as `chrome.storage.session` does. */
function createArea(): SnapshotStorageAreaLike & { read: () => unknown } {
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
    }),
    read: () => {
      const value = stored[LIVE_SESSION_SNAPSHOTS_KEY];
      return value === undefined ? undefined : (JSON.parse(value) as unknown);
    }
  };
}

describe("live session store", () => {
  it("round-trips checkpoints, replacing a session's older one", async () => {
    const area = createArea();
    const store = createLiveSessionStore(area);

    await store.remember(live("S-1", 5_000));
    await store.remember(live("S-2", 6_000));
    await store.remember(live("S-1", 7_000));

    expect((await store.list()).map((row) => [row.sid, row.lastSeenAt])).toEqual([
      ["S-2", 6_000],
      ["S-1", 7_000]
    ]);

    await store.forget("S-2");
    expect((await store.list()).map((row) => row.sid)).toEqual(["S-1"]);

    await store.clear();
    expect(area.read()).toEqual([]);
  });

  it("keeps nothing without a storage area", async () => {
    const store = createLiveSessionStore(undefined);

    await store.remember(live("S-1"));

    expect(await store.list()).toEqual([]);
  });

  it("skips malformed checkpoints", () => {
    const withoutTime: Record<string, unknown> = { ...live("S-no-time") };
    delete withoutTime.lastSeenAt;

    expect(
      parseLiveSessionSnapshots([
        live("S-ok"),
        withoutTime,
        { ...live("S-bad-mode"), mode: "turbo" },
        "junk"
      ]).map((row) => row.sid)
    ).toEqual(["S-ok"]);
    expect(parseLiveSessionSnapshots(undefined)).toEqual([]);
  });

  it("turns a checkpoint into an interrupted stopped recording", () => {
    const stopped = toInterruptedSnapshot(live("S-1", 5_000), {
      detectedAt: 9_000,
      ttlMs: 60_000
    });

    expect(stopped).toMatchObject({
      sid: "S-1",
      startedAt: 1_000,
      stoppedAt: 5_000,
      expiresAt: 65_000,
      purgeAttempts: 0,
      counters: { eventCount: 40, errorCount: 2, sizeBytes: 9_000, budgetAlertCount: 0 },
      interruption: { reason: "service-worker-restart", detectedAt: 9_000, lastSeenAt: 5_000 }
    });
    expect(stopped).not.toHaveProperty("lastSeenAt");
  });
});
