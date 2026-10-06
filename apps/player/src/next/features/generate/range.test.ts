import { describe, expect, it } from "vitest";

import {
  clampMaxActions,
  commitTypedRange,
  formatRangeLabel,
  parseSeconds,
  rangeText,
  resolveGenerateRange,
  toPlayerRange
} from "./range.js";

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

  describe("typed From / To", () => {
    const bounds = { minMono: 1_000, maxMono: 13_000 };
    // An action at 2006.4 ms from the start: "2.01" on screen, not the exact time.
    const precise = { startMono: 3_006.4, endMono: 9_000 };

    it("parses seconds with a dot or a comma, and nothing else", () => {
      expect(parseSeconds(" 9,45 ")).toBe(9.45);
      expect(parseSeconds("12")).toBe(12);
      expect(parseSeconds("")).toBeNull();
      expect(parseSeconds("abc")).toBeNull();
      expect(parseSeconds("5s")).toBeNull();
    });

    it("leaves an untouched range exactly as it was", () => {
      expect(rangeText(precise, bounds)).toEqual({ from: "2.01", to: "8.00" });
      expect(commitTypedRange(rangeText(precise, bounds), precise, bounds)).toEqual({
        status: "unchanged"
      });
    });

    it("reads only the edited field and keeps the other end's exact time", () => {
      expect(commitTypedRange({ from: "2.01", to: "10" }, precise, bounds)).toEqual({
        status: "applied",
        range: { startMono: 3_006.4, endMono: 11_000 }
      });
    });

    it("rejects an empty field, a non-number and a range shorter than 50 ms", () => {
      expect(commitTypedRange({ from: "", to: "8.00" }, precise, bounds)).toEqual({
        status: "invalid",
        reason: "not-a-number",
        fields: ["from"]
      });
      expect(commitTypedRange({ from: "x", to: "y" }, null, bounds)).toMatchObject({
        reason: "not-a-number",
        fields: ["from", "to"]
      });
      expect(commitTypedRange({ from: "2.01", to: "2.03" }, precise, bounds)).toEqual({
        status: "invalid",
        reason: "too-short",
        fields: ["to"]
      });
    });

    it("turns a typed range over the whole recording into no range", () => {
      expect(commitTypedRange({ from: "0", to: "99" }, precise, bounds)).toEqual({
        status: "applied",
        range: null
      });
    });
  });
});
