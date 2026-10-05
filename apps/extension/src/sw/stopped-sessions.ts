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

/** Stopped-session lifetime: the in-memory TTL, capped by the configured local retention. */
export function resolveStoppedSessionTtlMs(
  inMemoryTtlMs: number,
  localRetentionTtlMs: number | undefined
): number {
  return isPositiveFinite(localRetentionTtlMs)
    ? Math.min(inMemoryTtlMs, localRetentionTtlMs)
    : inMemoryTtlMs;
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
