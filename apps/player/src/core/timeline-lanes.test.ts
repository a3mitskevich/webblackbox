import type { RouteChapter } from "@webblackbox/player-sdk";
import { describe, expect, it } from "vitest";

import {
  buildDensityBins,
  buildLaneTicks,
  compactChapters,
  findNearest,
  isErrorRouteLabel,
  ratioOf
} from "./timeline-lanes.js";

const WINDOW = { minMono: 1_000, durationMono: 10_000 };

function chapter(label: string, startMono: number, endMono: number, kind = "route"): RouteChapter {
  return { label, startMono, endMono, kind: kind as RouteChapter["kind"] };
}

describe("ratioOf", () => {
  it("maps time to 0…1", () => {
    expect(ratioOf(1_000, WINDOW)).toBe(0);
    expect(ratioOf(6_000, WINDOW)).toBe(0.5);
    expect(ratioOf(99_000, WINDOW)).toBe(1);
    expect(ratioOf(0, WINDOW)).toBe(0);
    expect(ratioOf(5_000, { minMono: 0, durationMono: 0 })).toBe(0);
    expect(ratioOf(Number.NaN, WINDOW)).toBe(0);
  });
});

describe("buildDensityBins", () => {
  it("counts requests per bin and flags failures", () => {
    const bins = buildDensityBins(
      [
        { startMono: 1_000, failed: false },
        { startMono: 1_100, failed: true },
        { startMono: 6_000, failed: false },
        { startMono: 11_000, failed: false }
      ],
      WINDOW,
      4
    );

    expect(bins).toEqual([
      { count: 2, failed: true },
      { count: 0, failed: false },
      { count: 1, failed: false },
      { count: 1, failed: false }
    ]);
  });
});

describe("buildLaneTicks", () => {
  it("sorts and collapses ticks that would overlap", () => {
    expect(buildLaneTicks([6_000, 1_000, 1_010, 11_000], WINDOW)).toEqual([0, 0.5, 1]);
  });
});

describe("compactChapters", () => {
  it("keeps wide chapters and merges runs of narrow ones", () => {
    const result = compactChapters(
      [
        chapter("#/error", 1_000, 3_000, "load"),
        chapter("/", 3_000, 3_200, "reload"),
        chapter("#/error", 3_200, 3_300),
        chapter("#/", 3_300, 3_400),
        chapter("#/a", 3_400, 3_500),
        chapter("#/lobby", 3_500, 8_000),
        chapter("#/x", 8_000, 8_100)
      ],
      WINDOW
    );

    expect(
      result.map((entry) => [entry.label, entry.startMono, entry.endMono, entry.isErrorRoute])
    ).toEqual([
      ["#/error", 1_000, 3_000, true],
      ["↻ / → #/error → #/ …", 3_000, 3_500, true],
      ["#/lobby", 3_500, 8_000, false],
      ["#/x", 8_000, 8_100, false]
    ]);
    expect(result[1]?.kind).toBe("reload");
    expect(compactChapters([], WINDOW)).toEqual([]);
  });

  it("recognises error routes", () => {
    expect(isErrorRouteLabel("#/error")).toBe(true);
    expect(isErrorRouteLabel("/500")).toBe(true);
    expect(isErrorRouteLabel("/errors/404/")).toBe(true);
    expect(isErrorRouteLabel("/cart/4041")).toBe(false);
    expect(isErrorRouteLabel("#/lobby")).toBe(false);
  });
});

describe("findNearest", () => {
  it("returns the closest item", () => {
    const items = [{ mono: 10 }, { mono: 20 }, { mono: 40 }];
    const pick = (item: { mono: number }) => item.mono;

    expect(findNearest(items, pick, 14)?.mono).toBe(10);
    expect(findNearest(items, pick, 31)?.mono).toBe(40);
    expect(findNearest(items, pick, 0)?.mono).toBe(10);
    expect(findNearest(items, pick, 99)?.mono).toBe(40);
    expect(findNearest([], pick, 1)).toBeNull();
  });
});
