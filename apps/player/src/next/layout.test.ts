import { describe, expect, it } from "vitest";

import {
  clearStoredLayouts,
  defaultBodyLayout,
  defaultDetailsLayout,
  defaultRailWidth,
  layoutId,
  STAGE_MIN_PERCENT
} from "./layout.js";

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));

  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    }
  };
}

describe("player layout", () => {
  it("starts the rail at 440 / 520 / 680 px by window width (PROPOSAL §5)", () => {
    expect(defaultRailWidth(1024)).toBe(440);
    expect(defaultRailWidth(1280)).toBe(440);
    expect(defaultRailWidth(1440)).toBe(520);
    expect(defaultRailWidth(1799)).toBe(520);
    expect(defaultRailWidth(1920)).toBe(680);
  });

  it("splits the body in percent and never squeezes the stage below its minimum", () => {
    const wide = defaultBodyLayout(1440, 1440);
    expect(wide["layout-rail"]).toBeCloseTo((520 / 1440) * 100);
    expect((wide["layout-stage"] ?? 0) + (wide["layout-rail"] ?? 0)).toBeCloseTo(100);

    const narrow = defaultBodyLayout(700, 1440);
    expect(narrow["layout-stage"]).toBeCloseTo(STAGE_MIN_PERCENT);
  });

  it("gives the details pane 40% under the list by default", () => {
    expect(defaultDetailsLayout()).toEqual({ "layout-list": 60, "layout-details": 40 });
  });

  it("drops only the player's stored splits on reset", () => {
    const storage = memoryStorage({
      [`react-resizable-panels:${layoutId("body")}`]: '{"layout-stage":60,"layout-rail":40}',
      [`react-resizable-panels:${layoutId("details")}`]: '{"layout-list":70,"layout-details":30}',
      "react-resizable-panels:other-app": "{}",
      "webblackbox.player.theme": "dark"
    });

    clearStoredLayouts(storage);

    expect([...storage.map.keys()].sort()).toEqual([
      "react-resizable-panels:other-app",
      "webblackbox.player.theme"
    ]);
  });

  it("survives a storage that throws", () => {
    const broken = {
      get length(): number {
        throw new Error("blocked");
      },
      key: () => null,
      removeItem: () => undefined
    };

    expect(() => clearStoredLayouts(broken)).not.toThrow();
  });
});
