import type { CaptureMode, RecorderConfig, SessionInterruption } from "@webblackbox/protocol";

import { parseCaptureFallback, type CaptureFallback } from "../shared/capture-fallback.js";
import type { FullModeVisualCapture } from "../shared/messages.js";
import type { ProfileSelection } from "../shared/profiles/resolve.js";
import type { ProfileCancellation } from "./profile-change.js";
import type { CapturedVisuals } from "./profile-runtime.js";
import { isKeptUntilExported } from "./stopped-sessions.js";

/**
 * Stopped, unexported recordings stay listed and exportable until the browser closes, although
 * Chrome stops an idle service worker within a minute. Each stop leaves a snapshot of what the
 * worker needs to rebuild the session; a new worker restores it and the encrypted pipeline data
 * is read again with the same per-browser-session key. Snapshots live in `chrome.storage.session`
 * next to the key (memory-backed, trusted contexts only): they hold the URL, title and profile of
 * a recording, which must not reach the disk.
 */
export const STOPPED_SESSION_SNAPSHOTS_KEY = "webblackbox.atRest.stoppedSessions";
export const MAX_STOPPED_SESSION_SNAPSHOTS = 50;
/** After this many failed purges a recording is given up on; it ends with the browser session. */
export const MAX_STOPPED_SESSION_PURGE_ATTEMPTS = 3;
const RETENTION_ALARM_PREFIX = "webblackbox.retention:";

export type StoppedSessionSnapshot = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  startedAt: number;
  stoppedAt: number;
  /** When the unexported recording is deleted (the profile's retention). */
  expiresAt: number;
  url: string;
  title?: string;
  profile: {
    request: string;
    visualCapture?: FullModeVisualCapture;
    selection: ProfileSelection;
    profileConfig: RecorderConfig;
    visualsCaptured: CapturedVisuals;
    /** A recording cancelled by a profile change keeps its reason for the popup and badge. */
    cancellation?: ProfileCancellation;
    cancellationAcknowledged?: boolean;
  };
  config: RecorderConfig;
  counters: {
    eventCount: number;
    errorCount: number;
    sizeBytes: number;
    budgetAlertCount: number;
  };
  /** Failed purges so far; such a recording is retried by its alarm, not at worker start. */
  purgeAttempts?: number;
  /** Set for a recording an earlier worker left running: it ended without Stop. */
  interruption?: SessionInterruption;
  /** Set when the recording left the Full engine and went on in Light. */
  captureFallback?: CaptureFallback;
  /** Not exported yet: the popup asks to export it. */
  exportPrompt?: boolean;
};

export type SnapshotStorageAreaLike = {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

export type StoppedSessionStore = {
  list(): Promise<StoppedSessionSnapshot[]>;
  remember(snapshot: StoppedSessionSnapshot): Promise<void>;
  forget(sid: string): Promise<void>;
  /** Counts a failed purge; resolves the new count, or null without a snapshot. */
  recordPurgeFailure(sid: string): Promise<number | null>;
  clear(): Promise<void>;
};

export function parseStoppedSessionSnapshots(value: unknown): StoppedSessionSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<StoppedSessionSnapshot[]>((snapshots, item) => {
    const parsed = parseStoppedSessionSnapshot(item);
    return parsed ? upsertStoppedSessionSnapshot(snapshots, parsed) : snapshots;
  }, []);
}

/** Adds or replaces the snapshot of `snapshot.sid`; the oldest ones go past the cap. */
export function upsertStoppedSessionSnapshot(
  snapshots: readonly StoppedSessionSnapshot[],
  snapshot: StoppedSessionSnapshot
): StoppedSessionSnapshot[] {
  const next = [...snapshots.filter((row) => row.sid !== snapshot.sid), snapshot];
  return next.slice(-MAX_STOPPED_SESSION_SNAPSHOTS);
}

export function removeStoppedSessionSnapshot(
  snapshots: readonly StoppedSessionSnapshot[],
  sid: string
): StoppedSessionSnapshot[] {
  return snapshots.filter((row) => row.sid !== sid);
}

export type StoppedSessionRestorePlan = {
  /** Inside their retention: restored, listed and exportable. */
  kept: StoppedSessionSnapshot[];
  /** Past their retention: purged at worker start. */
  purgeNow: StoppedSessionSnapshot[];
  /** Past their retention after a failed purge: left to their retry alarm, off the start path. */
  purgeLater: StoppedSessionSnapshot[];
};

/** What a new worker does with each snapshot an earlier worker left. */
export function planStoppedSessionRestore(
  snapshots: readonly StoppedSessionSnapshot[],
  now: number
): StoppedSessionRestorePlan {
  const expired = snapshots.filter((row) => row.expiresAt <= now);

  return {
    kept: snapshots.filter((row) => row.expiresAt > now),
    purgeNow: expired.filter((row) => (row.purgeAttempts ?? 0) === 0),
    purgeLater: expired.filter((row) => (row.purgeAttempts ?? 0) > 0)
  };
}

/** `chrome.alarms` name of a recording's retention; alarms survive worker restarts. */
export function retentionAlarmName(sid: string): string {
  return `${RETENTION_ALARM_PREFIX}${sid}`;
}

export function sidFromRetentionAlarm(name: string): string | null {
  return name.startsWith(RETENTION_ALARM_PREFIX) && name.length > RETENTION_ALARM_PREFIX.length
    ? name.slice(RETENTION_ALARM_PREFIX.length)
    : null;
}

export type RetentionAlarmsLike = {
  create(name: string, alarmInfo: { when: number }): Promise<void> | void;
  clear(name: string): Promise<boolean> | void;
};

/**
 * Schedules the deletion of a stopped recording at `expiresAt`; a recording kept until it is
 * exported gets no alarm (a stale one is cleared). Returns false without `chrome.alarms`; the
 * caller then falls back to a timer that dies with the worker.
 */
export async function scheduleRetentionAlarm(
  alarms: RetentionAlarmsLike | undefined,
  sid: string,
  expiresAt: number
): Promise<boolean> {
  if (!alarms) {
    return false;
  }

  if (isKeptUntilExported(expiresAt)) {
    await alarms.clear(retentionAlarmName(sid));
    return true;
  }

  await alarms.create(retentionAlarmName(sid), { when: expiresAt });
  return true;
}

export async function clearRetentionAlarm(
  alarms: RetentionAlarmsLike | undefined,
  sid: string
): Promise<void> {
  await alarms?.clear(retentionAlarmName(sid));
}

/** A list of snapshots under one key of `area`, read and written through one serial queue. */
export type SnapshotList<TSnapshot> = {
  enqueue: <TResult>(task: () => Promise<TResult>) => Promise<TResult>;
  read: () => Promise<TSnapshot[]>;
  write: (rows: TSnapshot[]) => Promise<void>;
  update: (change: (rows: TSnapshot[]) => TSnapshot[]) => Promise<void>;
};

/** Serialized access to the snapshot list under `key`; without an area nothing is kept. */
export function createSnapshotList<TSnapshot>(
  area: SnapshotStorageAreaLike | undefined,
  key: string,
  parse: (value: unknown) => TSnapshot[]
): SnapshotList<TSnapshot> {
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <TResult>(task: () => Promise<TResult>): Promise<TResult> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const read = async (): Promise<TSnapshot[]> => (area ? parse((await area.get(key))?.[key]) : []);
  const write = async (rows: TSnapshot[]): Promise<void> => {
    await area?.set({ [key]: rows });
  };

  return {
    enqueue,
    read,
    write,
    update: (change) =>
      enqueue(async () => {
        if (area) {
          await write(change(await read()));
        }
      })
  };
}

/** Snapshot store over `area`; writes are serialized. Without an area nothing is kept. */
export function createStoppedSessionStore(
  area: SnapshotStorageAreaLike | undefined
): StoppedSessionStore {
  const snapshots = createSnapshotList(
    area,
    STOPPED_SESSION_SNAPSHOTS_KEY,
    parseStoppedSessionSnapshots
  );

  return {
    list: () => snapshots.enqueue(snapshots.read),
    remember: (snapshot) =>
      snapshots.update((rows) => upsertStoppedSessionSnapshot(rows, snapshot)),
    forget: (sid) => snapshots.update((rows) => removeStoppedSessionSnapshot(rows, sid)),
    recordPurgeFailure: (sid) =>
      snapshots.enqueue(async () => {
        const rows = await snapshots.read();
        const row = rows.find((candidate) => candidate.sid === sid);

        if (!row || !area) {
          return null;
        }

        const purgeAttempts = (row.purgeAttempts ?? 0) + 1;
        await snapshots.write(
          rows.map((candidate) =>
            candidate.sid === sid ? { ...candidate, purgeAttempts } : candidate
          )
        );
        return purgeAttempts;
      }),
    clear: () => snapshots.update(() => [])
  };
}

function parseStoppedSessionSnapshot(value: unknown): StoppedSessionSnapshot | null {
  const core = parseSessionSnapshotCore(value);

  if (
    !core ||
    !isRecord(value) ||
    !isFiniteNumber(value.stoppedAt) ||
    !isFiniteNumber(value.expiresAt) ||
    value.expiresAt < value.stoppedAt
  ) {
    return null;
  }

  const interruption = parseSessionInterruption(value.interruption);

  return {
    ...core,
    stoppedAt: value.stoppedAt,
    expiresAt: value.expiresAt,
    purgeAttempts: isFiniteNumber(value.purgeAttempts) ? Math.max(0, value.purgeAttempts) : 0,
    ...(interruption ? { interruption } : {}),
    ...(value.exportPrompt === true ? { exportPrompt: true } : {})
  };
}

/** The interruption of a snapshot; an invalid one is dropped (the recording is still kept). */
export function parseSessionInterruption(value: unknown): SessionInterruption | undefined {
  if (
    !isRecord(value) ||
    value.reason !== "service-worker-restart" ||
    !isFiniteNumber(value.detectedAt) ||
    (value.lastSeenAt !== undefined && !isFiniteNumber(value.lastSeenAt))
  ) {
    return undefined;
  }

  return {
    reason: value.reason,
    detectedAt: value.detectedAt,
    ...(isFiniteNumber(value.lastSeenAt) ? { lastSeenAt: value.lastSeenAt } : {})
  };
}

/** What every session snapshot (stopped or live) holds: identity, URL, profile, config, counters. */
export type SessionSnapshotCore = Omit<
  StoppedSessionSnapshot,
  "stoppedAt" | "expiresAt" | "purgeAttempts" | "interruption" | "exportPrompt"
>;

/** Parses the shared snapshot fields; the caller checks its own timing fields. */
export function parseSessionSnapshotCore(value: unknown): SessionSnapshotCore | null {
  if (!isRecord(value)) {
    return null;
  }

  const { profile, config, counters } = value;

  if (
    typeof value.sid !== "string" ||
    value.sid.length === 0 ||
    typeof value.tabId !== "number" ||
    (value.mode !== "lite" && value.mode !== "full") ||
    !isFiniteNumber(value.startedAt) ||
    typeof value.url !== "string" ||
    (value.title !== undefined && typeof value.title !== "string") ||
    !isRecord(profile) ||
    typeof profile.request !== "string" ||
    !isRecord(profile.selection) ||
    !isRecord(profile.selection.profile) ||
    !isRecord(profile.profileConfig) ||
    !isRecord(profile.visualsCaptured) ||
    !isRecord(config) ||
    !isRecord(config.redaction)
  ) {
    return null;
  }

  const count = (key: string): number => {
    const raw = isRecord(counters) ? counters[key] : undefined;
    return isFiniteNumber(raw) ? raw : 0;
  };
  const captureFallback = parseCaptureFallback(value.captureFallback);

  // The snapshot was written by this extension into a trusted-contexts-only area: the nested
  // profile and config are taken as written.
  return {
    sid: value.sid,
    tabId: value.tabId,
    mode: value.mode,
    startedAt: value.startedAt,
    url: value.url,
    ...(value.title !== undefined ? { title: value.title } : {}),
    profile: profile as unknown as SessionSnapshotCore["profile"],
    config: config as unknown as SessionSnapshotCore["config"],
    counters: {
      eventCount: count("eventCount"),
      errorCount: count("errorCount"),
      sizeBytes: count("sizeBytes"),
      budgetAlertCount: count("budgetAlertCount")
    },
    ...(captureFallback ? { captureFallback } : {})
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
