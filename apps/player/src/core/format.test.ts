import { describe, expect, it } from "vitest";

import {
  formatClock,
  formatOffset,
  formatRecordedAt,
  formatRulerSeconds,
  resolveRulerStepMs
} from "./format.js";

describe("formatClock", () => {
  it("formats m:ss.cc with the locale decimal separator", () => {
    expect(formatClock(10_890, "en")).toBe("0:10.89");
    expect(formatClock(10_890, "ru")).toBe("0:10,89");
    expect(formatClock(17_800, "zh-CN")).toBe("0:17.80");
    expect(formatClock(125_004, "en")).toBe("2:05.00");
  });

  it("truncates instead of rounding and treats invalid input as zero", () => {
    expect(formatClock(10_899, "en")).toBe("0:10.89");
    expect(formatClock(-5, "en")).toBe("0:00.00");
    expect(formatClock(Number.NaN, "en")).toBe("0:00.00");
  });
});

describe("list and ruler formats", () => {
  it("formats offsets and ruler ticks", () => {
    expect(formatOffset(10_890, "en")).toBe("10.89");
    expect(formatOffset(10_890, "ru")).toBe("10,89");
    expect(formatOffset(1_234_567, "en")).toBe("1234.56");
    expect(formatRulerSeconds(3_000, "en")).toBe("3");
    expect(formatRulerSeconds(17_800, "ru", 1)).toBe("17,8");
  });

  it("picks readable ruler steps", () => {
    expect(resolveRulerStepMs(17_800)).toBe(3_000);
    expect(resolveRulerStepMs(600_000)).toBe(120_000);
    expect(resolveRulerStepMs(0)).toBe(1_000);
    expect(resolveRulerStepMs(100 * 3_600_000)).toBe(3_600_000);
  });

  it("formats the recording date or returns empty for invalid input", () => {
    expect(formatRecordedAt("2026-10-05T11:57:00.000Z", "en")).toMatch(/2026/);
    expect(formatRecordedAt("not a date", "en")).toBe("");
  });
});
