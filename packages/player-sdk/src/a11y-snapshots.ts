import {
  formatA11yNodeLine,
  parseA11yTree,
  validateEventData,
  type DomA11ySnapshotData,
  type ParsedA11yTreeLine,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

/** A `dom.a11y.snapshot`: what the viewport showed and offered at one moment. */
export type A11ySnapshotEntry = DomA11ySnapshotData & {
  eventId: string;
  t: number;
  mono: number;
  /** The user action the snapshot belongs to (`ref.act`). */
  actionId?: string;
};

/** A moment in the session: a monotonic time, a wall-clock time, an event, or an action. */
export type PageStateAnchor = {
  mono?: number;
  t?: number;
  eventId?: string;
  actionId?: string;
};

export type ResolvedPageStateAnchor = {
  mono: number;
  t?: number;
  eventId?: string;
  eventType?: string;
  actionId?: string;
};

export type PageStateAt = {
  anchor: ResolvedPageStateAnchor;
  /** The snapshot taken for the anchor event or action (its trigger or its action span). */
  linked?: A11ySnapshotEntry;
  /** The latest snapshot at or before the anchor. */
  before?: A11ySnapshotEntry;
  /** The first snapshot after the anchor. */
  after?: A11ySnapshotEntry;
};

/** Every valid accessibility snapshot, in time order. */
export function listA11ySnapshots(events: readonly WebBlackboxEvent[]): A11ySnapshotEntry[] {
  const entries: A11ySnapshotEntry[] = [];

  for (const event of events) {
    if (event.type !== "dom.a11y.snapshot") {
      continue;
    }

    const parsed = validateEventData("dom.a11y.snapshot", event.data);

    if (!parsed.success) {
      continue;
    }

    entries.push({
      ...(parsed.data as DomA11ySnapshotData),
      eventId: event.id,
      t: event.t,
      mono: event.mono,
      ...(event.ref?.act ? { actionId: event.ref.act } : {})
    });
  }

  return entries.sort((left, right) => left.mono - right.mono);
}

/**
 * The page state around a moment: the snapshot linked to the anchor event or action, and the
 * nearest snapshots before and after it. Null when the anchor cannot be resolved.
 */
export function findPageStateAt(
  events: readonly WebBlackboxEvent[],
  anchor: PageStateAnchor,
  snapshots: readonly A11ySnapshotEntry[] = listA11ySnapshots(events)
): PageStateAt | null {
  const resolved = resolveAnchor(events, anchor);

  if (!resolved) {
    return null;
  }

  const linked = findLinkedSnapshot(snapshots, resolved);
  const before = findLast(snapshots, (entry) => entry.mono <= resolved.mono);
  const after = snapshots.find((entry) => entry.mono > resolved.mono);

  return {
    anchor: resolved,
    ...(linked ? { linked } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {})
  };
}

function resolveAnchor(
  events: readonly WebBlackboxEvent[],
  anchor: PageStateAnchor
): ResolvedPageStateAnchor | null {
  if (anchor.eventId !== undefined) {
    const event = events.find((candidate) => candidate.id === anchor.eventId);
    return event ? describeEvent(event) : null;
  }

  if (anchor.actionId !== undefined) {
    // The action timeline names actions without `ref.act` after their first event.
    const derivedFrom = anchor.actionId.startsWith(DERIVED_ACTION_PREFIX)
      ? anchor.actionId.slice(DERIVED_ACTION_PREFIX.length)
      : undefined;
    const start = events.find((candidate) =>
      derivedFrom !== undefined
        ? candidate.id === derivedFrom
        : candidate.ref?.act === anchor.actionId
    );

    if (!start) {
      return null;
    }

    return derivedFrom !== undefined
      ? describeEvent(start)
      : { ...describeEvent(start), actionId: anchor.actionId };
  }

  if (anchor.mono !== undefined && Number.isFinite(anchor.mono)) {
    return { mono: anchor.mono };
  }

  if (anchor.t !== undefined && Number.isFinite(anchor.t)) {
    const nearest = nearestByWallClock(events, anchor.t);
    return nearest ? { mono: nearest.mono + (anchor.t - nearest.t), t: anchor.t } : null;
  }

  return null;
}

const DERIVED_ACTION_PREFIX = "derived:";

function describeEvent(event: WebBlackboxEvent): ResolvedPageStateAnchor {
  return {
    mono: event.mono,
    t: event.t,
    eventId: event.id,
    eventType: event.type,
    ...(event.ref?.act ? { actionId: event.ref.act } : {})
  };
}

function nearestByWallClock(
  events: readonly WebBlackboxEvent[],
  t: number
): WebBlackboxEvent | undefined {
  let best: WebBlackboxEvent | undefined;

  for (const event of events) {
    if (!best || Math.abs(event.t - t) < Math.abs(best.t - t)) {
      best = event;
    }
  }

  return best;
}

function findLinkedSnapshot(
  snapshots: readonly A11ySnapshotEntry[],
  anchor: ResolvedPageStateAnchor
): A11ySnapshotEntry | undefined {
  if (anchor.eventId) {
    const byTrigger = snapshots.find((entry) => entry.trigger.eventId === anchor.eventId);

    if (byTrigger) {
      return byTrigger;
    }

    if (anchor.eventType === "dom.a11y.snapshot") {
      return snapshots.find((entry) => entry.eventId === anchor.eventId);
    }
  }

  return anchor.actionId
    ? snapshots.find((entry) => entry.actionId === anchor.actionId && entry.mono >= anchor.mono)
    : undefined;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;

    if (predicate(item)) {
      return item;
    }
  }

  return undefined;
}

/** What to look for on the page: a text (in names and values), a role, or both. */
export type PageQuery = {
  text?: string;
  role?: string;
  monoStart?: number;
  monoEnd?: number;
};

export type PageSnapshotRef = {
  eventId: string;
  t: number;
  mono: number;
  /**
   * The capture cut this snapshot at its budget: a match missing from it may lie past the cut, so
   * a `disappeared` on a cut snapshot is uncertain.
   */
  truncated?: true;
  /** How the snapshot was masked: text matches cannot be seen in masked names or values. */
  masking: A11ySnapshotEntry["masking"];
};

/** One stretch of time the query matched in consecutive snapshots. */
export type PagePresenceSpan = {
  appeared: PageSnapshotRef;
  lastSeen: PageSnapshotRef;
  /** The first later snapshot without a match; absent while it is still shown at the end. */
  disappeared?: PageSnapshotRef;
  /** The first snapshot's matching lines (up to {@link PAGE_QUERY_SAMPLE_LINES}). */
  sample: string[];
};

export type PageQueryResult = {
  snapshotsScanned: number;
  spans: PagePresenceSpan[];
  /** Matched in the last snapshot of the range. */
  presentAtEnd: boolean;
};

export const PAGE_QUERY_SAMPLE_LINES = 5;

/**
 * When something was on screen: the spans of consecutive snapshots in which a node matched the
 * text (case-insensitive, in its name or value) and/or the role. Snapshots cover the viewport,
 * so a match that went away may only have been scrolled out of view.
 */
export function findOnPage(
  snapshots: readonly A11ySnapshotEntry[],
  query: PageQuery
): PageQueryResult {
  const text = query.text?.trim().toLowerCase() ?? "";
  const role = query.role?.trim().toLowerCase() ?? "";
  const inRange = snapshots.filter(
    (entry) =>
      (query.monoStart === undefined || entry.mono >= query.monoStart) &&
      (query.monoEnd === undefined || entry.mono <= query.monoEnd)
  );
  const spans: PagePresenceSpan[] = [];
  let open: PagePresenceSpan | null = null;

  if (!text && !role) {
    return { snapshotsScanned: inRange.length, spans, presentAtEnd: false };
  }

  for (const entry of inRange) {
    const matches = parseA11yTree(entry.tree).filter((line) => matchesLine(line, text, role));
    const ref = toRef(entry);

    if (matches.length > 0) {
      if (open) {
        open.lastSeen = ref;
      } else {
        open = {
          appeared: ref,
          lastSeen: ref,
          sample: matches.slice(0, PAGE_QUERY_SAMPLE_LINES).map(describeLine)
        };
        spans.push(open);
      }

      continue;
    }

    if (open) {
      open.disappeared = ref;
      open = null;
    }
  }

  return { snapshotsScanned: inRange.length, spans, presentAtEnd: open !== null };
}

function matchesLine(line: ParsedA11yTreeLine, text: string, role: string): boolean {
  if (role && line.role.toLowerCase() !== role) {
    return false;
  }

  if (!text) {
    return true;
  }

  return (
    (line.name?.toLowerCase().includes(text) ?? false) ||
    (line.value?.toLowerCase().includes(text) ?? false)
  );
}

/** The node as its tree line, without the indentation and the leading dash. */
function describeLine(line: ParsedA11yTreeLine): string {
  return formatA11yNodeLine({
    role: line.role,
    name: line.name,
    states: line.states,
    value: line.value
  }).slice(2);
}

function toRef(entry: A11ySnapshotEntry): PageSnapshotRef {
  return {
    eventId: entry.eventId,
    t: entry.t,
    mono: entry.mono,
    ...(entry.truncated ? { truncated: true as const } : {}),
    masking: entry.masking
  };
}
