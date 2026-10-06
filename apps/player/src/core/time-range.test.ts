import { describe, expect, it } from "vitest";

import { isInRange, isSameRange, moveRangeEdge, normalizeRange } from "./time-range.js";

const bounds = { minMono: 1_000, maxMono: 11_000 };

describe("time range", () => {
  it("orders and clamps the ends, and drops a range shorter than a click", () => {
    expect(normalizeRange(5_000, 2_000, bounds)).toEqual({ startMono: 2_000, endMono: 5_000 });
    expect(normalizeRange(-50, 20_000, bounds)).toEqual({ startMono: 1_000, endMono: 11_000 });
    expect(normalizeRange(2_000, 2_010, bounds)).toBeNull();
    expect(normalizeRange(Number.NaN, 2_000, bounds)).toBeNull();
  });

  it("treats a missing range as the whole recording", () => {
    expect(isInRange(null, 42)).toBe(true);
    expect(isInRange({ startMono: 10, endMono: 20 }, 20)).toBe(true);
    expect(isInRange({ startMono: 10, endMono: 20 }, 21)).toBe(false);
  });

  it("moves one edge to the playhead, starting a range when there is none", () => {
    expect(moveRangeEdge(null, "start", 4_000, bounds)).toEqual({
      startMono: 4_000,
      endMono: 11_000
    });
    expect(moveRangeEdge(null, "end", 4_000, bounds)).toEqual({
      startMono: 1_000,
      endMono: 4_000
    });
    // Crossing the other end swaps them.
    expect(moveRangeEdge({ startMono: 2_000, endMono: 3_000 }, "start", 6_000, bounds)).toEqual({
      startMono: 3_000,
      endMono: 6_000
    });
  });

  it("compares ranges by their ends", () => {
    expect(isSameRange(null, null)).toBe(true);
    expect(isSameRange({ startMono: 1, endMono: 2 }, { startMono: 1, endMono: 2 })).toBe(true);
    expect(isSameRange({ startMono: 1, endMono: 2 }, null)).toBe(false);
  });
});
