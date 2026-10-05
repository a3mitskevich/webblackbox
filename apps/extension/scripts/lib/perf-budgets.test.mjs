import { describe, expect, it } from "vitest";

import {
  evaluateCountBudget,
  evaluateRatioBudget,
  evaluateSeriesBudget,
  mergeBudgetAttempts
} from "./perf-budgets.mjs";

const NAV_LIMITS = { ratioLimit: 1.7, deltaLimit: 80 };

describe("evaluateRatioBudget", () => {
  it("allows the larger of the ratio and the absolute delta over the baseline", () => {
    expect(evaluateRatioBudget("nav", 27, 107, NAV_LIMITS)).toMatchObject({
      threshold: 107,
      ok: true
    });
    expect(evaluateRatioBudget("nav", 200, 340, NAV_LIMITS)).toMatchObject({
      threshold: 340,
      ok: true
    });
    expect(evaluateRatioBudget("nav", 27, 150, NAV_LIMITS).ok).toBe(false);
  });

  it("refuses to compare a missing measurement", () => {
    expect(() => evaluateRatioBudget("nav", Number.NaN, 1, NAV_LIMITS)).toThrow(
      "Baseline metric is unavailable: nav"
    );
    expect(() => evaluateRatioBudget("nav", 1, undefined, NAV_LIMITS)).toThrow(
      "Recorded metric is unavailable: nav"
    );
  });
});

describe("evaluateSeriesBudget", () => {
  const RAF_LIMITS = { ratioLimit: 1.35, deltaLimit: 8 };
  const series = (count, p95Ms) => ({ count, p50Ms: p95Ms, p95Ms });

  it("compares the chosen statistic of two series", () => {
    expect(
      evaluateSeriesBudget("rafGap.p95Ms", series(9, 16.7), series(8, 16.7), "p95Ms", RAF_LIMITS)
    ).toMatchObject({ baseline: 16.7, recorded: 16.7, ok: true });
    expect(
      evaluateSeriesBudget("rafGap.p95Ms", series(9, 16.7), series(8, 50), "p95Ms", RAF_LIMITS).ok
    ).toBe(false);
  });

  it("skips a comparison when a side has no samples instead of treating it as 0 ms", () => {
    // Local run: no animation frame landed in an 840 ms baseline window, so "p95" was 0 and a
    // single normal 16.7 ms frame while recording exceeded the 8 ms threshold.
    expect(
      evaluateSeriesBudget("rafGap.p95Ms", series(0, 0), series(8, 16.7), "p95Ms", RAF_LIMITS)
    ).toEqual({
      metric: "rafGap.p95Ms",
      skipped: "no-samples",
      baselineCount: 0,
      recordedCount: 8,
      ok: true
    });
  });
});

describe("evaluateCountBudget", () => {
  it("allows at most deltaLimit more than the baseline", () => {
    expect(evaluateCountBudget("longTasks.count", 2, 6, 4).ok).toBe(true);
    expect(evaluateCountBudget("longTasks.count", 2, 7, 4).ok).toBe(false);
  });
});

describe("mergeBudgetAttempts", () => {
  const nav = (recorded) => evaluateRatioBudget("navigation.mouse.p50Ms", 27, recorded, NAV_LIMITS);
  const requests = (recorded) =>
    evaluateRatioBudget("requests.p95Ms", 80, recorded, { ratioLimit: 1.6, deltaLimit: 30 });

  it("passes a metric that one noisy attempt exceeded and a later attempt met", () => {
    // CI run 37224569109: one 150 ms outlier against a 27 ms baseline.
    const merged = mergeBudgetAttempts([
      [nav(150), requests(90)],
      [nav(41), requests(95)]
    ]);

    expect(merged.failures).toEqual([]);
    expect(
      merged.budgets.find((budget) => budget.metric === "navigation.mouse.p50Ms")
    ).toMatchObject({ recorded: 41, ok: true, recordedAttempts: [150, 41] });
  });

  it("judges every metric on its own best attempt", () => {
    const merged = mergeBudgetAttempts([
      [nav(150), requests(90)],
      [nav(40), requests(200)]
    ]);

    expect(merged.failures).toEqual([]);
  });

  it("does not let a skipped comparison mask a failing one", () => {
    const skipped = { metric: "rafGap.p95Ms", skipped: "no-samples", ok: true };
    const failing = evaluateRatioBudget("rafGap.p95Ms", 16.7, 50, {
      ratioLimit: 1.35,
      deltaLimit: 8
    });

    expect(mergeBudgetAttempts([[skipped], [failing]]).failures).toEqual([
      expect.objectContaining({ metric: "rafGap.p95Ms", recorded: 50, ok: false })
    ]);
    expect(mergeBudgetAttempts([[skipped], [skipped]])).toMatchObject({
      failures: [],
      budgets: [{ metric: "rafGap.p95Ms", skipped: "no-samples" }]
    });
  });

  it("fails a regression that exceeds the budget on every attempt", () => {
    // A 5x slowdown of a 27 ms navigation stays above the 107 ms threshold every time.
    const merged = mergeBudgetAttempts([[nav(140)], [nav(131)], [nav(152)]]);

    expect(merged.failures).toEqual([
      expect.objectContaining({
        metric: "navigation.mouse.p50Ms",
        recorded: 131,
        threshold: 107,
        ok: false,
        recordedAttempts: [140, 131, 152]
      })
    ]);
  });
});
