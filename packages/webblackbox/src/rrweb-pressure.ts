/**
 * Pressure mode of the rrweb DOM recorder: recording must never slow the page down.
 *
 * - A page with more than {@link DOM_RECORDER_MAX_NODES} nodes is not recorded by rrweb at all (one
 *   full snapshot of it costs hundreds of milliseconds and megabytes); the agent's own DOM capture
 *   (summaries and snapshots) takes over, as before rrweb.
 * - While recording, rrweb's main-thread time per mutation delivery is measured. When the time
 *   spent in a rolling {@link RRWEB_COST_WINDOW_MS} window exceeds {@link RRWEB_COST_BUDGET_MS}, or one
 *   change set is larger than {@link RRWEB_MUTATION_MAX_CHANGES}, recording pauses: rrweb is stopped
 *   and the change log has a gap, marked in the archive. An oversized change set is caught before
 *   rrweb serializes it (the cost observer runs first and stops rrweb), so a storm costs nothing.
 * - After the pause rrweb starts again with a fresh full snapshot, so replay is consistent from
 *   there on. Pauses that follow each other closely grow from {@link RRWEB_PAUSE_INITIAL_MS} up to
 *   {@link RRWEB_PAUSE_MAX_MS}; a stretch of {@link RRWEB_PAUSE_RESET_MS} without pressure resets them.
 *   A pause also lasts at least {@link RRWEB_SNAPSHOT_COST_FACTOR} times what the last full snapshot
 *   cost, so the snapshots that end pauses take at most ~2 % of the main thread.
 *
 * The heavy-SPA harness (task 56) measured ~14 s of main-thread script per 90 s with rrweb always
 * on (a 2,500-row table re-rendered on each route change, a ticker rewriting 120 cells every
 * 100 ms; ~25k live nodes). On that page one full snapshot is ~2 MB of JSON and ~0.3 s of main
 * thread, so it is left to the agent's own capture; on the pages rrweb records it spends at most
 * ~3 % of the main thread over any second on changes.
 */

/**
 * Pages with more nodes (elements, text, comments) than this are left to the agent's own DOM
 * capture. A full snapshot grows with the nodes: ~2 MB of JSON and ~0.3 s at the heavy SPA's
 * ~25k; ordinary pages have a few thousand.
 */
export const DOM_RECORDER_MAX_NODES = 20_000;
/** The rolling window over which rrweb's main-thread time is summed. */
export const RRWEB_COST_WINDOW_MS = 1_000;
/** rrweb may spend at most this much main-thread time per window before it pauses. */
export const RRWEB_COST_BUDGET_MS = 30;
/** One change set (added + removed nodes, text and attribute changes) larger than this pauses. */
export const RRWEB_MUTATION_MAX_CHANGES = 5_000;
/** First pause; each pause that follows the last resume within the reset window doubles it. */
export const RRWEB_PAUSE_INITIAL_MS = 2_000;
export const RRWEB_PAUSE_MAX_MS = 60_000;
/** A pause lasts at least this many times the last full snapshot's main-thread cost. */
export const RRWEB_SNAPSHOT_COST_FACTOR = 50;
/** Recording this long without pressure brings the next pause back to its initial length. */
export const RRWEB_PAUSE_RESET_MS = 30_000;

export type RrwebPressureReason = "mutation-cost" | "mutation-size";

export type RrwebPressureVerdict =
  { pause: false } | { pause: true; reason: RrwebPressureReason; costMs: number };

type CostSample = { at: number; ms: number };

/**
 * Changes in one mutation delivery as rrweb would record them, counted up to `limit` (then it
 * stops): records, removed nodes, and added nodes with all their descendants (rrweb records each
 * added node, text nodes included). A walk is much cheaper than rrweb's serialization of the same
 * delivery.
 */
export function countRecordChanges(records: readonly MutationRecord[], limit: number): number {
  let total = 0;

  for (const record of records) {
    total += 1 + record.removedNodes.length;

    for (const node of Array.from(record.addedNodes)) {
      total += countSubtreeNodes(node, limit - total + 1);

      if (total > limit) {
        return total;
      }
    }

    if (total > limit) {
      return total;
    }
  }

  return total;
}

/** A node and its descendants, counted up to `limit` + 1. */
function countSubtreeNodes(node: Node, limit: number): number {
  const walker = (node.ownerDocument ?? (node as Document)).createTreeWalker(
    node,
    NodeFilter.SHOW_ALL
  );
  let count = 1;

  while (count <= limit && walker.nextNode()) {
    count += 1;
  }

  return count;
}

/** Nodes of a document (all kinds, shadow roots excluded), counted up to `limit` + 1. */
export function countDocumentNodes(doc: Document, limit: number): number {
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ALL);
  let count = 0;

  while (walker.nextNode()) {
    count += 1;

    if (count > limit) {
      break;
    }
  }

  return count;
}

/** Number of changes in an rrweb mutation event (`IncrementalSource.Mutation` data). */
export function countMutationChanges(data: unknown): number {
  if (data === null || typeof data !== "object") {
    return 0;
  }

  const record = data as Record<string, unknown>;
  return ["adds", "removes", "texts", "attributes"].reduce((total, key) => {
    const list = record[key];
    return total + (Array.isArray(list) ? list.length : 0);
  }, 0);
}

/**
 * Decides when rrweb pauses and for how long. Times are `performance.now()` milliseconds; the
 * gauge keeps only the samples of the current window.
 */
export class RrwebPressureGauge {
  private samples: readonly CostSample[] = [];
  private nextPauseMs = RRWEB_PAUSE_INITIAL_MS;
  private lastResumeAt = Number.NEGATIVE_INFINITY;
  private snapshotCostMs = 0;

  /** The main-thread cost of the last full snapshot (rrweb's start or resume). */
  public noteSnapshotCost(costMs: number): void {
    this.snapshotCostMs = Number.isFinite(costMs) && costMs > 0 ? costMs : 0;
  }

  /** Records one mutation delivery: its main-thread cost and its number of changes. */
  public measureMutation(costMs: number, changes: number, now: number): RrwebPressureVerdict {
    const cost = Number.isFinite(costMs) && costMs > 0 ? costMs : 0;
    this.samples = [
      ...this.samples.filter((sample) => now - sample.at < RRWEB_COST_WINDOW_MS),
      { at: now, ms: cost }
    ];
    const windowCost = this.samples.reduce((total, sample) => total + sample.ms, 0);

    if (changes > RRWEB_MUTATION_MAX_CHANGES) {
      return { pause: true, reason: "mutation-size", costMs: windowCost };
    }

    if (windowCost > RRWEB_COST_BUDGET_MS) {
      return { pause: true, reason: "mutation-cost", costMs: windowCost };
    }

    return { pause: false };
  }

  /**
   * How long the pause that starts now lasts: consecutive pauses back off, and a pause is never
   * shorter than the snapshot that ends it allows.
   */
  public startPause(now: number): number {
    const backoffMs =
      now - this.lastResumeAt >= RRWEB_PAUSE_RESET_MS ? RRWEB_PAUSE_INITIAL_MS : this.nextPauseMs;
    this.nextPauseMs = Math.min(backoffMs * 2, RRWEB_PAUSE_MAX_MS);
    this.samples = [];
    return Math.min(
      RRWEB_PAUSE_MAX_MS,
      Math.max(backoffMs, Math.round(this.snapshotCostMs * RRWEB_SNAPSHOT_COST_FACTOR))
    );
  }

  /** rrweb records again (with a fresh full snapshot). */
  public markResumed(now: number): void {
    this.lastResumeAt = now;
    this.samples = [];
  }
}
