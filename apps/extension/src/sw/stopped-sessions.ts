import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";

/**
 * Persisted bookkeeping for stopped sessions. The in-memory cleanup timer of a stopped
 * session dies with the MV3 service worker, so each stop is recorded in
 * `chrome.storage.local` and the pipeline IndexedDB is swept on worker start.
 */
export type StoppedSessionRecord = {
  sid: string;
  stoppedAt: number;
  expiresAt: number;
};

export type StoredSessionSweepInput = {
  session: { sid: string; startedAt: number };
  liveSids: ReadonlySet<string>;
  records: ReadonlyMap<string, StoppedSessionRecord>;
  now: number;
  bootedAt: number;
};

export const STOPPED_SESSIONS_STORAGE_KEY = "webblackbox.runtime.stoppedSessions";
export const MAX_STOPPED_SESSION_RECORDS = 200;

export function parseStoppedSessionRecords(value: unknown): StoppedSessionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<StoppedSessionRecord[]>((records, item) => {
    const parsed = parseStoppedSessionRecord(item);
    return parsed ? upsertStoppedSessionRecord(records, parsed) : records;
  }, []);
}

/**
 * `expiresAt` of a recording kept until it is exported or deleted: no timer deletes it, only the
 * end of the at-rest key (the browser closing) does.
 */
export const KEPT_UNTIL_EXPORTED_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

/**
 * Stopped-session lifetime: the profile's retention, capped by the capture policy's local
 * retention; null = kept until exported or deleted. Such a recording is capped only by a local
 * retention below the default one, which an administrator (or a v1 option) set on purpose.
 */
export function resolveStoppedSessionTtlMs(
  profileTtlMs: number | null,
  localRetentionTtlMs: number | undefined
): number | null {
  if (profileTtlMs === null) {
    return isPositiveFinite(localRetentionTtlMs) &&
      localRetentionTtlMs < DEFAULT_CAPTURE_POLICY.retention.localTtlMs
      ? localRetentionTtlMs
      : null;
  }

  return isPositiveFinite(localRetentionTtlMs)
    ? Math.min(profileTtlMs, localRetentionTtlMs)
    : profileTtlMs;
}

/** When a recording stopped at `from` expires; `KEPT_UNTIL_EXPORTED_EXPIRES_AT` for no TTL. */
export function resolveExpiresAt(from: number, ttlMs: number | null): number {
  return ttlMs === null
    ? KEPT_UNTIL_EXPORTED_EXPIRES_AT
    : Math.min(from + ttlMs, KEPT_UNTIL_EXPORTED_EXPIRES_AT);
}

/** The recording waits for its export or deletion: no retention timer is scheduled. */
export function isKeptUntilExported(expiresAt: number): boolean {
  return expiresAt >= KEPT_UNTIL_EXPORTED_EXPIRES_AT;
}

export function upsertStoppedSessionRecord(
  records: readonly StoppedSessionRecord[],
  record: StoppedSessionRecord
): StoppedSessionRecord[] {
  const next = [...records.filter((row) => row.sid !== record.sid), record];
  return next.slice(-MAX_STOPPED_SESSION_RECORDS);
}

export function removeStoppedSessionRecord(
  records: readonly StoppedSessionRecord[],
  sid: string
): StoppedSessionRecord[] {
  return records.filter((row) => row.sid !== sid);
}

export function pruneStoppedSessionRecords(
  records: readonly StoppedSessionRecord[],
  now: number,
  deletedSids: ReadonlySet<string>
): StoppedSessionRecord[] {
  return records.filter((row) => row.expiresAt > now && !deletedSids.has(row.sid));
}

/**
 * A stored session is swept when this worker does not own it and it is either an
 * orphan (no stopped record: the worker died mid-recording or before the record was
 * written) or its stopped-session retention has expired. Sessions started after this
 * worker booted are never touched, so a sweep cannot race a fresh Start.
 */
export function shouldSweepStoredSession(input: StoredSessionSweepInput): boolean {
  if (input.liveSids.has(input.session.sid) || input.session.startedAt >= input.bootedAt) {
    return false;
  }

  const record = input.records.get(input.session.sid);
  return !record || record.expiresAt <= input.now;
}

function parseStoppedSessionRecord(value: unknown): StoppedSessionRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;

  if (
    typeof row.sid !== "string" ||
    row.sid.length === 0 ||
    !isPositiveFinite(row.stoppedAt) ||
    !isPositiveFinite(row.expiresAt) ||
    row.expiresAt < row.stoppedAt
  ) {
    return null;
  }

  return {
    sid: row.sid,
    stoppedAt: row.stoppedAt,
    expiresAt: row.expiresAt
  };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
