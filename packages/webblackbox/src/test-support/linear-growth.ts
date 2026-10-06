/** Test helper: linear-time checks that parallel load cannot fail (CPU time, no fixed budget). */

const LINEAR_INPUT_FACTOR = 8;
/** Well above linear growth (8-11x) plus shared-runner noise, well below quadratic (>= 56x). */
export const LINEAR_GROWTH_LIMIT = 32;

/**
 * Hang-only bound for a growth-ratio test. Several timed runs, repeated over the limit, take
 * seconds on a loaded runner, past vitest's 5 s default; no assertion depends on this value.
 */
export const GROWTH_TEST_TIMEOUT_MS = 60_000;
/** Inputs are doubled so each run takes long enough for timer noise not to matter. */
const BASE_SCALE = 2;
/**
 * Noise only ever inflates a ratio, while quadratic code exceeds the limit on every attempt,
 * so a measurement over the limit is repeated a few times before it counts.
 */
const MAX_ATTEMPTS = 3;

/**
 * The fastest of several runs, in process CPU time rather than wall-clock: time spent
 * descheduled by other load is not counted, and the minimum drops GC pauses.
 */
function fastestRunMs(run: () => unknown, runs: number): number {
  let fastest = Number.POSITIVE_INFINITY;

  for (let index = 0; index < runs; index += 1) {
    const startedAt = process.cpuUsage();
    run();
    const used = process.cpuUsage(startedAt);
    fastest = Math.min(fastest, (used.user + used.system) / 1_000);
  }

  return fastest;
}

function measureRatio(prepare: (scale: number) => () => unknown): number {
  const smallMs = fastestRunMs(prepare(BASE_SCALE), 11);
  const largeMs = fastestRunMs(prepare(BASE_SCALE * LINEAR_INPUT_FACTOR), 5);

  return largeMs / Math.max(smallMs, 0.05);
}

/**
 * How much slower a run gets on 8x more input: about 8x when linear, 64x when quadratic.
 * `prepare(scale)` sets up the input for that scale (outside the timing) and returns the run.
 */
export function growthRatio(prepare: (scale: number) => () => unknown): number {
  let best = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && best >= LINEAR_GROWTH_LIMIT; attempt += 1) {
    best = Math.min(best, measureRatio(prepare));
  }

  return best;
}
