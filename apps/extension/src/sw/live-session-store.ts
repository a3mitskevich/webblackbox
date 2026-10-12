import type { SessionInterruption } from "@webblackbox/protocol";

import {
  createSnapshotList,
  isFiniteNumber,
  isRecord,
  MAX_STOPPED_SESSION_SNAPSHOTS,
  parseSessionSnapshotCore,
  type SessionSnapshotCore,
  type SnapshotStorageAreaLike,
  type StoppedSessionSnapshot
} from "./stopped-session-store.js";
import { resolveExpiresAt } from "./stopped-sessions.js";

/**
 * Running recordings, checkpointed while they record. A worker that dies mid-recording (MV3 stops
 * service workers) leaves them here, and the next worker keeps each one as an interrupted
 * recording instead of sweeping its data as an orphan. Same area and privacy rules as the
 * stopped snapshots: `chrome.storage.session` (memory-backed, trusted contexts only).
 */
export const LIVE_SESSION_SNAPSHOTS_KEY = "webblackbox.atRest.liveSessions";
/** Shortest gap between two checkpoints of a running recording. */
export const LIVE_SESSION_CHECKPOINT_INTERVAL_MS = 10_000;

export type LiveSessionSnapshot = SessionSnapshotCore & {
  /** The last checkpoint: the recording was known to be running then. */
  lastSeenAt: number;
};

export type LiveSessionStore = {
  list(): Promise<LiveSessionSnapshot[]>;
  remember(snapshot: LiveSessionSnapshot): Promise<void>;
  forget(sid: string): Promise<void>;
  clear(): Promise<void>;
};

export function parseLiveSessionSnapshots(value: unknown): LiveSessionSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<LiveSessionSnapshot[]>((snapshots, item) => {
    const core = parseSessionSnapshotCore(item);

    if (!core || !isRecord(item) || !isFiniteNumber(item.lastSeenAt)) {
      return snapshots;
    }

    return upsertLiveSessionSnapshot(snapshots, { ...core, lastSeenAt: item.lastSeenAt });
  }, []);
}

/** Adds or replaces the snapshot of `snapshot.sid`; the oldest ones go past the cap. */
export function upsertLiveSessionSnapshot(
  snapshots: readonly LiveSessionSnapshot[],
  snapshot: LiveSessionSnapshot
): LiveSessionSnapshot[] {
  const next = [...snapshots.filter((row) => row.sid !== snapshot.sid), snapshot];
  return next.slice(-MAX_STOPPED_SESSION_SNAPSHOTS);
}

/** Live snapshot store over `area`; writes are serialized. Without an area nothing is kept. */
export function createLiveSessionStore(
  area: SnapshotStorageAreaLike | undefined
): LiveSessionStore {
  const snapshots = createSnapshotList(area, LIVE_SESSION_SNAPSHOTS_KEY, parseLiveSessionSnapshots);

  return {
    list: () => snapshots.enqueue(snapshots.read),
    remember: (snapshot) => snapshots.update((rows) => upsertLiveSessionSnapshot(rows, snapshot)),
    forget: (sid) => snapshots.update((rows) => rows.filter((row) => row.sid !== sid)),
    clear: () => snapshots.update(() => [])
  };
}

/**
 * The stopped snapshot of a recording a new worker found still "running": it ended at its last
 * checkpoint, and its retention counts from there, as for a recording stopped then.
 */
export function toInterruptedSnapshot(
  live: LiveSessionSnapshot,
  options: { detectedAt: number; ttlMs: number | null }
): StoppedSessionSnapshot {
  const { lastSeenAt, ...core } = live;
  const interruption: SessionInterruption = {
    reason: "service-worker-restart",
    detectedAt: options.detectedAt,
    lastSeenAt
  };

  return {
    ...core,
    stoppedAt: lastSeenAt,
    expiresAt: resolveExpiresAt(lastSeenAt, options.ttlMs),
    purgeAttempts: 0,
    interruption,
    // Kept like a stopped recording, so it asks to be exported like one.
    exportPrompt: true
  };
}
