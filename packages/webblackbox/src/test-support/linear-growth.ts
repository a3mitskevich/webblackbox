/** Test helper: linear-time checks that parallel load cannot fail (no wall-clock budget). */

const LINEAR_INPUT_FACTOR = 8;
/** Well above linear growth (8x) plus noise, well below quadratic growth (64x). */
export const LINEAR_GROWTH_LIMIT = 24;

/** The fastest of several runs: CPU contention only ever adds time, so the minimum is stable. */
function fastestRunMs(run: () => unknown, runs: number): number {
  let fastest = Number.POSITIVE_INFINITY;

  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - startedAt);
  }

  return fastest;
}

/**
 * How much slower a run gets on 8x more input: about 8x when linear, 64x when quadratic.
 * `prepare(scale)` sets up the input for that scale (outside the timing) and returns the run.
 */
export function growthRatio(prepare: (scale: number) => () => unknown): number {
  const smallMs = fastestRunMs(prepare(1), 7);
  const largeMs = fastestRunMs(prepare(LINEAR_INPUT_FACTOR), 3);

  return largeMs / Math.max(smallMs, 0.05);
}
