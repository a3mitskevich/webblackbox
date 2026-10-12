import type {
  ArchiveCompleteness,
  ChunkTimeIndexEntry,
  ArchiveTruncation,
  ArchiveTruncationReason,
  SessionInterruption
} from "@webblackbox/protocol";

/** Report order of the reasons: what the user chose first, then what went wrong. */
const REASON_ORDER: readonly ArchiveTruncationReason[] = [
  "recent-window",
  "size-limit",
  "screenshots-excluded",
  "screen-recordings-excluded",
  "chunk-unreadable"
];

/** Data an export left out for one reason: counts and the wall-clock range they span. */
export type TruncationEntry = {
  events: number;
  chunks: number;
  fromT?: number;
  toT?: number;
};

/**
 * Tallies what an export leaves out, per reason, while chunks are selected, filtered and dropped
 * to fit the size limit. Each chunk is counted when it is read or dropped, never on a replan.
 */
export class TruncationLedger {
  private readonly entries = new Map<ArchiveTruncationReason, TruncationEntry>();

  public constructor(private readonly limits: Partial<Record<ArchiveTruncationReason, number>>) {}

  public add(reason: ArchiveTruncationReason, entry: TruncationEntry): void {
    if (entry.events === 0 && entry.chunks === 0) {
      return;
    }

    const current = this.entries.get(reason);

    this.entries.set(reason, {
      events: (current?.events ?? 0) + entry.events,
      chunks: (current?.chunks ?? 0) + entry.chunks,
      fromT: minDefined(current?.fromT, entry.fromT),
      toT: maxDefined(current?.toT, entry.toT)
    });
  }

  public toCompleteness(input: {
    storedEvents: number;
    storedChunks: number;
    interruption?: SessionInterruption;
  }): ArchiveCompleteness {
    const truncations = REASON_ORDER.flatMap((reason): ArchiveTruncation[] => {
      const entry = this.entries.get(reason);

      if (!entry) {
        return [];
      }

      const limit = this.limits[reason];

      return [
        {
          reason,
          events: entry.events,
          chunks: entry.chunks,
          ...(entry.fromT !== undefined ? { fromT: entry.fromT } : {}),
          ...(entry.toT !== undefined ? { toT: entry.toT } : {}),
          ...(limit !== undefined ? { limit } : {})
        }
      ];
    });

    return {
      storedEvents: input.storedEvents,
      storedChunks: input.storedChunks,
      truncations,
      ...(input.interruption ? { interruption: { ...input.interruption } } : {})
    };
  }
}

/** Events a filter left out, per reason, with their time range. */
export function tallyDroppedEvents(
  dropped: ReadonlyArray<{ t: number; reason: ArchiveTruncationReason }>
): Map<ArchiveTruncationReason, TruncationEntry> {
  const tally = new Map<ArchiveTruncationReason, TruncationEntry>();

  for (const { t, reason } of dropped) {
    const current = tally.get(reason);

    tally.set(reason, {
      events: (current?.events ?? 0) + 1,
      chunks: 0,
      fromT: minDefined(current?.fromT, t),
      toT: maxDefined(current?.toT, t)
    });
  }

  return tally;
}

/** A whole stored chunk left out. */
export function chunkEntry(meta: ChunkTimeIndexEntry): TruncationEntry {
  return {
    events: meta.eventCount,
    chunks: 1,
    fromT: Math.min(meta.tStart, meta.tEnd),
    toT: Math.max(meta.tStart, meta.tEnd)
  };
}

/** The reason that left out most events of a tally. */
export function largestReason(
  tally: ReadonlyMap<ArchiveTruncationReason, { events: number }>
): ArchiveTruncationReason | null {
  let largest: ArchiveTruncationReason | null = null;
  let largestEvents = -1;

  for (const [reason, entry] of tally) {
    if (entry.events > largestEvents) {
      largest = reason;
      largestEvents = entry.events;
    }
  }

  return largest;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.max(left, right);
}
