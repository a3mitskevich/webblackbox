import { assert } from "./e2e-utils.mjs";

/**
 * Perf budgets compare one baseline measurement with up to N recorded attempts.
 *
 * Machine noise (shared CI runners, GC, other jobs) only ever adds time, so a noisy attempt
 * can exceed a budget once, while a real recording overhead exceeds it on every attempt.
 * A budget therefore passes when at least one attempt meets it.
 */

/** recorded <= max(baseline * ratio, baseline + delta, delta) */
export function evaluateRatioBudget(metric, baseline, recorded, { ratioLimit, deltaLimit }) {
  assertFiniteMetric(metric, baseline, recorded);

  const threshold = Math.max(
    baseline * Math.max(1, ratioLimit),
    baseline + Math.max(0, deltaLimit),
    Math.max(0, deltaLimit)
  );

  return {
    metric,
    baseline,
    recorded,
    threshold,
    ratioLimit,
    deltaLimit,
    ok: recorded <= threshold
  };
}

/** recorded <= baseline + delta */
export function evaluateCountBudget(metric, baseline, recorded, deltaLimit) {
  assertFiniteMetric(metric, baseline, recorded);

  const threshold = baseline + Math.max(0, deltaLimit);

  return {
    metric,
    baseline,
    recorded,
    threshold,
    deltaLimit,
    ok: recorded <= threshold
  };
}

/**
 * Folds the budgets of every recorded attempt into one verdict per metric: the best
 * (lowest recorded) passing attempt, else the best failing one. `recordedAttempts` lists every
 * attempt's value so a failure shows that the regression was consistent.
 *
 * @param {Array<Array<{ metric: string, recorded: number, ok: boolean }>>} attempts
 */
export function mergeBudgetAttempts(attempts) {
  const byMetric = new Map();

  for (const budgets of attempts) {
    for (const budget of budgets) {
      byMetric.set(budget.metric, [...(byMetric.get(budget.metric) ?? []), budget]);
    }
  }

  const budgets = [...byMetric.values()].map((candidates) => {
    const passing = candidates.filter((candidate) => candidate.ok);
    const pool = passing.length > 0 ? passing : candidates;
    const best = pool.reduce((left, right) => (right.recorded < left.recorded ? right : left));

    return {
      ...best,
      recordedAttempts: candidates.map((candidate) => candidate.recorded)
    };
  });

  return {
    budgets,
    failures: budgets.filter((budget) => !budget.ok)
  };
}

function assertFiniteMetric(metric, baseline, recorded) {
  assert(
    typeof baseline === "number" && Number.isFinite(baseline),
    `Baseline metric is unavailable: ${metric}`,
    { baseline }
  );
  assert(
    typeof recorded === "number" && Number.isFinite(recorded),
    `Recorded metric is unavailable: ${metric}`,
    { recorded }
  );
}
