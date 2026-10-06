import { describe, expect, it } from "vitest";

import { findByTime, isSameSelection, stepInList } from "./navigation.js";

type Item = { id: string; mono: number; error?: boolean };

const ITEMS: Item[] = [
  { id: "a", mono: 100 },
  { id: "b", mono: 200, error: true },
  { id: "c", mono: 300 },
  { id: "d", mono: 400, error: true }
];
const pickMono = (item: Item) => item.mono;
const pickId = (item: Item) => item.id;

describe("findByTime", () => {
  it("finds the next and previous item strictly around the time", () => {
    expect(findByTime(ITEMS, pickMono, 200, 1)?.id).toBe("c");
    expect(findByTime(ITEMS, pickMono, 200, -1)?.id).toBe("a");
    expect(findByTime(ITEMS, pickMono, 0, 1)?.id).toBe("a");
    expect(findByTime(ITEMS, pickMono, 400, 1)).toBeNull();
    expect(findByTime(ITEMS, pickMono, 100, -1)).toBeNull();
  });

  it("skips items the filter rejects", () => {
    const isError = (item: Item) => item.error === true;

    expect(findByTime(ITEMS, pickMono, 0, 1, isError)?.id).toBe("b");
    expect(findByTime(ITEMS, pickMono, 200, 1, isError)?.id).toBe("d");
    expect(findByTime(ITEMS, pickMono, 350, -1, isError)?.id).toBe("b");
  });
});

describe("stepInList", () => {
  it("moves from the selected item", () => {
    const options = { pickId, pickMono, selectedId: "b", playheadMono: 0 };

    expect(stepInList(ITEMS, { ...options, direction: 1 })?.id).toBe("c");
    expect(stepInList(ITEMS, { ...options, direction: -1 })?.id).toBe("a");
    expect(stepInList(ITEMS, { ...options, selectedId: "d", direction: 1 })).toBeNull();
  });

  it("starts from the playhead without a selection in the list", () => {
    expect(
      stepInList(ITEMS, { pickId, pickMono, selectedId: "zz", playheadMono: 250, direction: 1 })?.id
    ).toBe("c");
    expect(
      stepInList(ITEMS, { pickId, pickMono, selectedId: null, playheadMono: 250, direction: -1 })
        ?.id
    ).toBe("b");
  });
});

describe("isSameSelection", () => {
  it("compares kind and id", () => {
    expect(isSameSelection({ kind: "event", id: "1" }, { kind: "event", id: "1" })).toBe(true);
    expect(isSameSelection({ kind: "event", id: "1" }, { kind: "request", id: "1" })).toBe(false);
    expect(isSameSelection(null, null)).toBe(true);
    expect(isSameSelection(null, { kind: "action", id: "1" })).toBe(false);
  });
});
