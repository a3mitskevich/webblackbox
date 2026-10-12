import { describe, expect, it } from "vitest";

import {
  capList,
  cutText,
  decodeCursor,
  encodeCursor,
  jsonBytes,
  paginate,
  shrinkListsToBudget
} from "./budget.js";

describe("cutText", () => {
  it("keeps short text whole", () => {
    expect(cutText("hello", 10)).toEqual({
      text: "hello",
      totalBytes: 5,
      returnedBytes: 5,
      truncated: false,
      note: null
    });
  });

  it("cuts on a UTF-8 character boundary and says how much it kept", () => {
    // "é" is two bytes: a cut after byte 4 would split the second one.
    const cut = cutText("aéé", 4);

    expect(cut.text).toBe("aé");
    expect(cut.returnedBytes).toBe(3);
    expect(cut.totalBytes).toBe(5);
    expect(cut.truncated).toBe(true);
    expect(cut.note).toBe("3 of 5 bytes");
  });
});

describe("paginate", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ index, text: "x".repeat(20) }));

  it("pages by limit and hands out a cursor until the end", () => {
    const first = paginate(rows, { limit: 4, maxBytes: 100_000 });
    const second = paginate(rows, { limit: 4, maxBytes: 100_000, cursor: first.nextCursor ?? "" });
    const last = paginate(rows, { limit: 4, maxBytes: 100_000, cursor: second.nextCursor ?? "" });

    expect(first.rows.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(first).toMatchObject({ total: 10, offset: 0, truncated: true, nextCursor: "o:4" });
    expect(second.rows.map((row) => row.index)).toEqual([4, 5, 6, 7]);
    expect(last.rows.map((row) => row.index)).toEqual([8, 9]);
    expect(last).toMatchObject({ truncated: false, nextCursor: null });
  });

  it("stops early at the byte budget but always returns one row", () => {
    const rowBytes = jsonBytes(rows[0]);
    const budgeted = paginate(rows, { limit: 10, maxBytes: rowBytes * 3 });
    const tiny = paginate(rows, { limit: 10, maxBytes: 1 });

    expect(budgeted.rows.length).toBeLessThan(10);
    expect(budgeted.rows.length).toBeGreaterThan(0);
    expect(budgeted.truncated).toBe(true);
    expect(tiny.rows).toHaveLength(1);
    expect(tiny.nextCursor).toBe("o:1");
  });

  it("rejects a cursor it did not make", () => {
    expect(() => decodeCursor("page-2")).toThrow(/Invalid cursor/);
    expect(decodeCursor(encodeCursor(7))).toBe(7);
  });
});

describe("shrinkListsToBudget", () => {
  it("halves the largest lists until the result fits and names them", () => {
    const big = capList(
      Array.from({ length: 40 }, () => "y".repeat(50)),
      40
    );
    const result: Record<string, unknown> = { small: capList(["a", "b"], 10), nested: { big } };
    const budget = Math.floor(jsonBytes(result) / 3);
    const shrunk = shrinkListsToBudget(result, budget);

    expect(shrunk).toEqual(["nested.big"]);
    expect(big.items.length).toBeLessThan(40);
    expect(big.total).toBe(40);
    expect(big.truncated).toBe(true);
    expect(jsonBytes(result)).toBeLessThanOrEqual(budget);
  });

  it("leaves a result that fits alone", () => {
    const result: Record<string, unknown> = { list: capList([1, 2, 3], 10) };

    expect(shrinkListsToBudget(result, 10_000)).toEqual([]);
    expect(result.list).toEqual({ total: 3, items: [1, 2, 3], truncated: false });
  });
});
