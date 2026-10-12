import {
  RRWEB_EVENT_TYPES,
  RRWEB_INCREMENTAL_SOURCES,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

import { captureDomView, diffDomViews, type RrwebDomDiffResult, type DomView } from "./diff.js";
import { asRecord } from "./serialized.js";
import {
  buildRrwebTimeline,
  incrementalSource,
  recorderStateAt,
  type RrwebClick,
  type RrwebInput,
  type RrwebStateEntry,
  type RrwebTimeline
} from "./timeline.js";
import { DomTree } from "./tree.js";

export * from "./diff.js";
export * from "./render.js";
export * from "./selector.js";
export * from "./timeline.js";
export * from "./tree.js";

/**
 * Rebuilds a recorded page's DOM at any moment from the archive's rrweb log, headlessly:
 * `domAt(mono)` replays the nearest full snapshot forward. Moving forward continues from the last
 * state; moving back rebuilds from a snapshot, whose distance is bounded by the recorder's
 * checkouts (every 2 min / 5k events).
 */

/** One call never applies more events than this (a bound for forged or broken archives). */
export const RRWEB_REPLAY_MAX_EVENTS = 200_000;
/** A click or input this close in time to an action's trigger is taken as the same one. */
export const RRWEB_MATCH_TOLERANCE_MS = 1_500;

export type RrwebDomState = {
  tree: DomTree;
  /** The moment asked for. */
  mono: number;
  /** The full snapshot the state was built from. */
  snapshotMono: number;
  /** Time of the last event applied (≤ `mono`). */
  appliedMono: number;
  /** URL and viewport of the page (rrweb's meta event before the snapshot). */
  href?: string;
  viewport?: { width: number; height: number };
  /** The recorder paused or gave up before `mono`: changes after `gapSince` are missing. */
  gap?: RrwebStateEntry;
  /** Events applied since the snapshot, and how many of their changes did not fit the tree. */
  eventsApplied: number;
  skippedChanges: number;
  /** Stopped at {@link RRWEB_REPLAY_MAX_EVENTS}: later events up to `mono` are missing. */
  truncated: boolean;
};

type Cursor = {
  tree: DomTree;
  snapshotIndex: number;
  /** Next entry to apply. */
  next: number;
  appliedMono: number;
  eventsApplied: number;
  skippedChanges: number;
  href?: string;
  viewport?: { width: number; height: number };
};

export class RrwebDomReplay {
  private cursor: Cursor | null = null;

  private constructor(public readonly timeline: RrwebTimeline) {}

  public static fromEvents(events: readonly WebBlackboxEvent[]): RrwebDomReplay {
    return new RrwebDomReplay(buildRrwebTimeline(events));
  }

  /** True when the archive has an rrweb log with at least one full snapshot. */
  public get hasRecording(): boolean {
    return this.timeline.fullSnapshots.length > 0;
  }

  public get clicks(): readonly RrwebClick[] {
    return this.timeline.clicks;
  }

  /**
   * The DOM after every rrweb event at or before `mono`, or null before the first full snapshot.
   * The returned tree is live: it changes on the next call (copy with `captureDomView`).
   */
  public domAt(mono: number): RrwebDomState | null {
    const snapshotIndex = this.snapshotIndexAt(mono);

    if (snapshotIndex === null) {
      return null;
    }

    const cursor =
      this.cursor && this.cursor.snapshotIndex === snapshotIndex && this.cursor.appliedMono <= mono
        ? this.cursor
        : this.startAt(snapshotIndex);
    this.cursor = cursor;
    let budget = RRWEB_REPLAY_MAX_EVENTS;
    const entries = this.timeline.entries;

    while (cursor.next < entries.length && entries[cursor.next]!.mono <= mono && budget > 0) {
      this.apply(cursor, cursor.next);
      cursor.next += 1;
      budget -= 1;
    }

    const truncated =
      budget === 0 && cursor.next < entries.length && entries[cursor.next]!.mono <= mono;
    const gap = recorderStateAt(this.timeline, mono);

    return {
      tree: cursor.tree,
      mono,
      snapshotMono: entries[snapshotIndex]!.mono,
      appliedMono: cursor.appliedMono,
      ...(cursor.href !== undefined ? { href: cursor.href } : {}),
      ...(cursor.viewport ? { viewport: cursor.viewport } : {}),
      ...(gap ? { gap } : {}),
      eventsApplied: cursor.eventsApplied,
      skippedChanges: cursor.skippedChanges,
      truncated
    };
  }

  /** A compact copy of the DOM at `mono` (for comparisons), or null. */
  public viewAt(mono: number): DomView | null {
    const state = this.domAt(mono);
    return state ? captureDomView(state.tree) : null;
  }

  /** What changed between two moments (`from` ≤ `to`), or null without a DOM at `from`. */
  public diff(from: number, to: number, maxItems?: number): RrwebDomDiffResult | null {
    const [start, end] = from <= to ? [from, to] : [to, from];
    const before = this.viewAt(start);
    const after = this.viewAt(end);
    return before && after ? diffDomViews(before, after, maxItems) : null;
  }

  /**
   * The rrweb click nearest to `mono` within the tolerance; with a point, among clicks equally
   * close in time the one nearest to it.
   */
  public findClick(
    mono: number,
    point?: { x: number; y: number },
    toleranceMs = RRWEB_MATCH_TOLERANCE_MS
  ): RrwebClick | null {
    const candidates = this.timeline.clicks.filter(
      (click) => Math.abs(click.mono - mono) <= toleranceMs
    );
    const score = (click: RrwebClick): number => {
      const distance =
        point && click.x !== undefined && click.y !== undefined
          ? Math.hypot(click.x - point.x, click.y - point.y)
          : 0;
      // A pixel of distance weighs like a millisecond of time.
      return Math.abs(click.mono - mono) + distance;
    };

    return candidates.reduce<RrwebClick | null>(
      (best, click) => (best === null || score(click) < score(best) ? click : best),
      null
    );
  }

  /** The rrweb field input nearest to `mono` within the tolerance. */
  public findInput(mono: number, toleranceMs = RRWEB_MATCH_TOLERANCE_MS): RrwebInput | null {
    return this.timeline.inputs.reduce<RrwebInput | null>((best, input) => {
      const distance = Math.abs(input.mono - mono);
      return distance <= toleranceMs && (best === null || distance < Math.abs(best.mono - mono))
        ? input
        : best;
    }, null);
  }

  private snapshotIndexAt(mono: number): number | null {
    let found: number | null = null;

    for (const index of this.timeline.fullSnapshots) {
      if (this.timeline.entries[index]!.mono > mono) {
        break;
      }

      found = index;
    }

    return found;
  }

  private startAt(snapshotIndex: number): Cursor {
    const entry = this.timeline.entries[snapshotIndex]!;
    const meta = this.metaBefore(snapshotIndex);
    return {
      tree: DomTree.fromSnapshot(asRecord(entry.event.data)?.node),
      snapshotIndex,
      next: snapshotIndex + 1,
      appliedMono: entry.mono,
      eventsApplied: 0,
      skippedChanges: 0,
      ...meta
    };
  }

  /** rrweb records a meta event (URL, viewport) right before each full snapshot. */
  private metaBefore(index: number): Pick<Cursor, "href" | "viewport"> {
    for (let at = index - 1; at >= 0 && at >= index - 3; at -= 1) {
      const event = this.timeline.entries[at]!.event;

      if (event.type === RRWEB_EVENT_TYPES.meta) {
        const data = asRecord(event.data) ?? {};
        const width = data.width;
        const height = data.height;
        return {
          ...(typeof data.href === "string" ? { href: data.href } : {}),
          ...(typeof width === "number" && typeof height === "number"
            ? { viewport: { width, height } }
            : {})
        };
      }
    }

    return {};
  }

  private apply(cursor: Cursor, index: number): void {
    const entry = this.timeline.entries[index]!;
    const source = incrementalSource(entry.event);
    cursor.appliedMono = entry.mono;

    if (source === RRWEB_INCREMENTAL_SOURCES.mutation) {
      const stats = cursor.tree.applyMutation(entry.event.data);
      cursor.skippedChanges += stats.skipped;
      cursor.eventsApplied += 1;
    } else if (source === RRWEB_INCREMENTAL_SOURCES.input) {
      cursor.tree.applyInput(entry.event.data);
      cursor.eventsApplied += 1;
    } else if (entry.event.type === RRWEB_EVENT_TYPES.meta) {
      const data = asRecord(entry.event.data) ?? {};

      if (typeof data.href === "string") {
        cursor.href = data.href;
      }
    }
  }
}
