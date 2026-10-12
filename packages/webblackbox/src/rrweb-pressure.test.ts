import { describe, expect, it } from "vitest";

import {
  countMutationChanges,
  RRWEB_COST_BUDGET_MS,
  RRWEB_COST_WINDOW_MS,
  RRWEB_MUTATION_MAX_CHANGES,
  RRWEB_PAUSE_INITIAL_MS,
  RRWEB_PAUSE_MAX_MS,
  RRWEB_PAUSE_RESET_MS,
  RrwebPressureGauge
} from "./rrweb-pressure.js";

describe("countMutationChanges", () => {
  it("counts added and removed nodes, text and attribute changes", () => {
    expect(
      countMutationChanges({
        source: 0,
        adds: [{}, {}],
        removes: [{}],
        texts: [{}, {}, {}],
        attributes: [{}]
      })
    ).toBe(7);
    expect(countMutationChanges({ source: 0 })).toBe(0);
    expect(countMutationChanges(null)).toBe(0);
  });
});

describe("RrwebPressureGauge", () => {
  it("pauses when the cost of one window goes over budget", () => {
    const gauge = new RrwebPressureGauge();
    const step = RRWEB_COST_BUDGET_MS / 4;

    expect(gauge.measureMutation(step, 10, 0).pause).toBe(false);
    expect(gauge.measureMutation(step, 10, 100).pause).toBe(false);
    expect(gauge.measureMutation(step, 10, 200).pause).toBe(false);
    expect(gauge.measureMutation(step, 10, 300).pause).toBe(false);
    expect(gauge.measureMutation(step, 10, 400)).toEqual({
      pause: true,
      reason: "mutation-cost",
      costMs: step * 5
    });
  });

  it("forgets the cost of earlier windows", () => {
    const gauge = new RrwebPressureGauge();
    const big = RRWEB_COST_BUDGET_MS * 0.9;

    expect(gauge.measureMutation(big, 1, 0).pause).toBe(false);
    expect(gauge.measureMutation(big, 1, RRWEB_COST_WINDOW_MS).pause).toBe(false);
    expect(gauge.measureMutation(big, 1, RRWEB_COST_WINDOW_MS * 2).pause).toBe(false);
  });

  it("pauses on one oversized change set whatever it cost", () => {
    const gauge = new RrwebPressureGauge();

    expect(gauge.measureMutation(0, RRWEB_MUTATION_MAX_CHANGES, 0).pause).toBe(false);
    expect(gauge.measureMutation(0, RRWEB_MUTATION_MAX_CHANGES + 1, 1)).toMatchObject({
      pause: true,
      reason: "mutation-size"
    });
  });

  it("ignores impossible costs", () => {
    const gauge = new RrwebPressureGauge();

    expect(gauge.measureMutation(Number.NaN, 1, 0).pause).toBe(false);
    expect(gauge.measureMutation(-500, 1, 1).pause).toBe(false);
  });

  it("backs off pauses that follow each other and resets after a calm stretch", () => {
    const gauge = new RrwebPressureGauge();

    expect(gauge.startPause(0)).toBe(RRWEB_PAUSE_INITIAL_MS);
    gauge.markResumed(RRWEB_PAUSE_INITIAL_MS);
    expect(gauge.startPause(RRWEB_PAUSE_INITIAL_MS + 1_000)).toBe(RRWEB_PAUSE_INITIAL_MS * 2);
    let now = RRWEB_PAUSE_INITIAL_MS * 4;

    for (let round = 0; round < 6; round += 1) {
      gauge.markResumed(now);
      now += 1_000;
      expect(gauge.startPause(now)).toBeLessThanOrEqual(RRWEB_PAUSE_MAX_MS);
    }

    gauge.markResumed(now);
    expect(gauge.startPause(now + 1_000)).toBe(RRWEB_PAUSE_MAX_MS);
    gauge.markResumed(now + 2_000);
    expect(gauge.startPause(now + 2_000 + RRWEB_PAUSE_RESET_MS)).toBe(RRWEB_PAUSE_INITIAL_MS);
  });

  it("starts each pause and resume with an empty window", () => {
    const gauge = new RrwebPressureGauge();

    gauge.measureMutation(RRWEB_COST_BUDGET_MS * 0.9, 1, 0);
    gauge.startPause(1);
    gauge.markResumed(2);
    expect(gauge.measureMutation(RRWEB_COST_BUDGET_MS * 0.9, 1, 3).pause).toBe(false);
  });
});
