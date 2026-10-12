/**
 * Pressure mode of the rrweb DOM recorder: recording must never slow the page down.
 *
 * - A page with more than {@link DOM_RECORDER_MAX_ELEMENTS} elements is not recorded by rrweb at all
 *   (one full snapshot of it costs hundreds of milliseconds and megabytes); the agent's own DOM
 *   capture (summaries and snapshots) takes over, as before rrweb.
 * - While recording, rrweb's main-thread time per mutation delivery is measured. When the time
 *   spent in a rolling {@link RRWEB_COST_WINDOW_MS} window exceeds {@link RRWEB_COST_BUDGET_MS}, or one
 *   change set is larger than {@link RRWEB_MUTATION_MAX_CHANGES}, recording pauses: rrweb is stopped
 *   and the change log has a gap, marked in the archive.
 * - After the pause rrweb starts again with a fresh full snapshot, so replay is consistent from
 *   there on. Pauses that follow each other closely grow from {@link RRWEB_PAUSE_INITIAL_MS} up to
 *   {@link RRWEB_PAUSE_MAX_MS}; a stretch of {@link RRWEB_PAUSE_RESET_MS} without pressure resets them.
 *
 * The heavy-SPA harness (task 56) measured ~14 s of main-thread script per 90 s with rrweb always
 * on (a 2,500-row table re-rendered on each route change, a ticker rewriting 120 cells every
 * 100 ms). The budget below keeps rrweb at no more than ~5 % of the main thread over any second.
 */

/** Pages with more elements than this are left to the agent's own DOM capture. */
export const DOM_RECORDER_MAX_ELEMENTS = 25_000;
/** The rolling window over which rrweb's main-thread time is summed. */
export const RRWEB_COST_WINDOW_MS = 1_000;
/** rrweb may spend at most this much main-thread time per window before it pauses. */
export const RRWEB_COST_BUDGET_MS = 50;
/** One change set (added + removed nodes, text and attribute changes) larger than this pauses. */
export const RRWEB_MUTATION_MAX_CHANGES = 5_000;
/** First pause; each pause that follows the last resume within the reset window doubles it. */
export const RRWEB_PAUSE_INITIAL_MS = 2_000;
export const RRWEB_PAUSE_MAX_MS = 30_000;
/** Recording this long without pressure brings the next pause back to its initial length. */
export const RRWEB_PAUSE_RESET_MS = 30_000;

export type RrwebPressureReason = "mutation-cost" | "mutation-size";

export type RrwebPressureVerdict =
  { pause: false } | { pause: true; reason: RrwebPressureReason; costMs: number };

type CostSample = { at: number; ms: number };

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

  /** How long the pause that starts now lasts; consecutive pauses back off. */
  public startPause(now: number): number {
    const pauseMs =
      now - this.lastResumeAt >= RRWEB_PAUSE_RESET_MS ? RRWEB_PAUSE_INITIAL_MS : this.nextPauseMs;
    this.nextPauseMs = Math.min(pauseMs * 2, RRWEB_PAUSE_MAX_MS);
    this.samples = [];
    return pauseMs;
  }

  /** rrweb records again (with a fresh full snapshot). */
  public markResumed(now: number): void {
    this.lastResumeAt = now;
    this.samples = [];
  }
}
