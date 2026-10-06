import { describe, expect, it } from "vitest";

import { isOwnListKey, nextListIndex } from "./list-keys.js";

describe("list keys", () => {
  const list = {} as EventTarget;
  const plain = {
    target: list,
    currentTarget: list,
    ctrlKey: false,
    altKey: false,
    metaKey: false
  };

  it("handles plain keys pressed on the list only", () => {
    expect(isOwnListKey(plain)).toBe(true);
    expect(isOwnListKey({ ...plain, target: {} as EventTarget })).toBe(false);
    expect(isOwnListKey({ ...plain, ctrlKey: true })).toBe(false);
    expect(isOwnListKey({ ...plain, altKey: true })).toBe(false);
    expect(isOwnListKey({ ...plain, metaKey: true })).toBe(false);
  });

  it("moves within the list bounds", () => {
    expect(nextListIndex("ArrowDown", -1, 5, 2)).toBe(0);
    expect(nextListIndex("ArrowDown", 4, 5, 2)).toBe(4);
    expect(nextListIndex("PageDown", 1, 5, 2)).toBe(3);
    expect(nextListIndex("PageUp", 1, 5, 2)).toBe(0);
    expect(nextListIndex("End", 0, 5, 2)).toBe(4);
    expect(nextListIndex("x", 0, 5, 2)).toBeNull();
    expect(nextListIndex("ArrowDown", 0, 0, 2)).toBeNull();
  });
});
