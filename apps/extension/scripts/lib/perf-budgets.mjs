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

/**
 * Ratio budget on one statistic (e.g. `p95Ms`) of two summarized series. A series without
 * samples (e.g. no animation frame landed in a short window) has no value rather than 0, so
 * the budget is skipped instead of comparing against 0.
 */
export function evaluateSeriesBudget(metric, baselineSeries, recordedSeries, statistic, limits) {
  const baselineCount = baselineSeries?.count ?? 0;
  const recordedCount = recordedSeries?.count ?? 0;

  if (baselineCount === 0 || recordedCount === 0) {
    return { metric, skipped: "no-samples", baselineCount, recordedCount, ok: true };
  }

  return evaluateRatioBudget(metric, baselineSeries[statistic], recordedSeries[statistic], limits);
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

  const budgets = [...byMetric.values()].map((allCandidates) => {
    // Skipped comparisons carry no information, so they can neither pass nor fail a metric.
    const candidates = allCandidates.filter((candidate) => !candidate.skipped);

    if (candidates.length === 0) {
      return { ...allCandidates[0], recordedAttempts: [] };
    }

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
