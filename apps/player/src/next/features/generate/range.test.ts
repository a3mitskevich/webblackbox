import { describe, expect, it } from "vitest";

import { clampMaxActions, formatRangeLabel, resolveGenerateRange, toPlayerRange } from "./range.js";

const timeline = { startMono: 2_000, endMono: 5_000 };

describe("generate range", () => {
  it("prefers the request's range, then the timeline range", () => {
    expect(resolveGenerateRange({}, timeline)).toBe(timeline);
    expect(resolveGenerateRange({ range: null }, timeline)).toBeNull();
    const own = { startMono: 1, endMono: 900 };
    expect(resolveGenerateRange({ range: own }, timeline)).toBe(own);
    expect(resolveGenerateRange({}, null)).toBeNull();
  });

  it("maps a range to player-sdk monoStart / monoEnd, and none to no filter", () => {
    expect(toPlayerRange(timeline)).toEqual({ monoStart: 2_000, monoEnd: 5_000 });
    expect(toPlayerRange(null)).toBeUndefined();
    expect(toPlayerRange(undefined)).toBeUndefined();
  });

  it("labels a range relative to the session start in the locale", () => {
    expect(formatRangeLabel(timeline, 500, "en")).toBe("0:01.50 – 0:04.50");
    expect(formatRangeLabel(timeline, 500, "ru")).toBe("0:01,50 – 0:04,50");
    expect(formatRangeLabel(null, 0, "en")).toBeNull();
  });

  it("keeps the action cap within 1…500", () => {
    expect(clampMaxActions(0)).toBe(1);
    expect(clampMaxActions(12.6)).toBe(13);
    expect(clampMaxActions(9_999)).toBe(500);
    expect(clampMaxActions(Number.NaN)).toBe(40);
  });
});
