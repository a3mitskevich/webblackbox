import { describe, expect, it } from "vitest";

import {
  MAX_STOPPED_SESSION_RECORDS,
  parseStoppedSessionRecords,
  pruneStoppedSessionRecords,
  removeStoppedSessionRecord,
  resolveStoppedSessionTtlMs,
  shouldSweepStoredSession,
  upsertStoppedSessionRecord,
  type StoppedSessionRecord
} from "./stopped-sessions.js";

const TEN_MINUTES = 10 * 60_000;

function record(sid: string, stoppedAt: number, expiresAt: number): StoppedSessionRecord {
  return { sid, stoppedAt, expiresAt };
}

describe("stopped session records", () => {
  it("parses only well-formed records from untrusted storage", () => {
    expect(parseStoppedSessionRecords(undefined)).toEqual([]);
    expect(parseStoppedSessionRecords("nope")).toEqual([]);
    expect(
      parseStoppedSessionRecords([
        record("S-1", 10, 20),
        { sid: "", stoppedAt: 1, expiresAt: 2 },
        { sid: "S-2", stoppedAt: "1", expiresAt: 2 },
        { sid: "S-3", stoppedAt: 1, expiresAt: Number.NaN },
        { sid: "S-4", stoppedAt: 5, expiresAt: 4 },
        null,
        record("S-1", 30, 40)
      ])
    ).toEqual([record("S-1", 30, 40)]);
  });

  it("caps the in-memory TTL with the configured local retention", () => {
    expect(resolveStoppedSessionTtlMs(TEN_MINUTES, undefined)).toBe(TEN_MINUTES);
    expect(resolveStoppedSessionTtlMs(TEN_MINUTES, 24 * 60 * 60_000)).toBe(TEN_MINUTES);
    expect(resolveStoppedSessionTtlMs(TEN_MINUTES, 60_000)).toBe(60_000);
    expect(resolveStoppedSessionTtlMs(TEN_MINUTES, 0)).toBe(TEN_MINUTES);
    expect(resolveStoppedSessionTtlMs(TEN_MINUTES, Number.NaN)).toBe(TEN_MINUTES);
  });

  it("upserts and removes records immutably", () => {
    const original = [record("S-1", 1, 2)];
    const upserted = upsertStoppedSessionRecord(original, record("S-1", 3, 4));
    const appended = upsertStoppedSessionRecord(upserted, record("S-2", 5, 6));

    expect(original).toEqual([record("S-1", 1, 2)]);
    expect(upserted).toEqual([record("S-1", 3, 4)]);
    expect(appended).toEqual([record("S-1", 3, 4), record("S-2", 5, 6)]);
    expect(removeStoppedSessionRecord(appended, "S-1")).toEqual([record("S-2", 5, 6)]);
    expect(appended).toHaveLength(2);
  });

  it("keeps only the newest records when the cap is exceeded", () => {
    let records: StoppedSessionRecord[] = [];

    for (let index = 0; index < MAX_STOPPED_SESSION_RECORDS + 5; index += 1) {
      records = upsertStoppedSessionRecord(records, record(`S-${index}`, index, index + 1));
    }

    expect(records).toHaveLength(MAX_STOPPED_SESSION_RECORDS);
    expect(records[0]?.sid).toBe("S-5");
  });

  it("prunes expired records and records of deleted sessions", () => {
    const records = [record("S-old", 1, 50), record("S-gone", 1, 500), record("S-keep", 1, 500)];

    expect(pruneStoppedSessionRecords(records, 100, new Set(["S-gone"]))).toEqual([
      record("S-keep", 1, 500)
    ]);
  });
});

describe("shouldSweepStoredSession", () => {
  const bootedAt = 1_000;
  const now = 2_000;

  function decide(
    session: { sid: string; startedAt: number },
    options: { live?: string[]; records?: StoppedSessionRecord[] } = {}
  ): boolean {
    return shouldSweepStoredSession({
      session,
      liveSids: new Set(options.live ?? []),
      records: new Map((options.records ?? []).map((row) => [row.sid, row])),
      now,
      bootedAt
    });
  }

  it("never sweeps a live session", () => {
    expect(decide({ sid: "S-live", startedAt: 10 }, { live: ["S-live"] })).toBe(false);
  });

  it("never sweeps a session started after this worker booted", () => {
    expect(decide({ sid: "S-new", startedAt: bootedAt })).toBe(false);
    expect(decide({ sid: "S-new", startedAt: bootedAt + 5 })).toBe(false);
  });

  it("sweeps orphaned sessions without a stopped record", () => {
    expect(decide({ sid: "S-orphan", startedAt: 10 })).toBe(true);
  });

  it("keeps stopped sessions until their retention expires", () => {
    expect(
      decide({ sid: "S-stopped", startedAt: 10 }, { records: [record("S-stopped", 900, 2_500)] })
    ).toBe(false);
    expect(
      decide({ sid: "S-stopped", startedAt: 10 }, { records: [record("S-stopped", 900, 2_000)] })
    ).toBe(true);
  });
});
