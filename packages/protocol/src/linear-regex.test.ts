import { describe, expect, it } from "vitest";

import { compileLinearRegex } from "./linear-regex.js";

const LINEAR_INPUT_FACTOR = 8;
// Well above linear growth (8x) plus noise, well below quadratic growth (64x).
const LINEAR_GROWTH_LIMIT = 24;

function fastestRunMs(run: () => unknown, runs: number): number {
  let fastest = Number.POSITIVE_INFINITY;

  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - startedAt);
  }

  return fastest;
}

describe("compileLinearRegex", () => {
  it("rejects patterns that need backtracking", () => {
    for (const pattern of ["(a)\\1", "a(?=b)", "(?<!a)b", "(", "[a"]) {
      expect(compileLinearRegex(pattern), pattern).toBeNull();
    }
  });

  it("replaces every leftmost-longest match, case-insensitively", () => {
    const regex = compileLinearRegex("sk_live_[a-z0-9]+");

    expect(regex?.replaceAll("a SK_LIVE_abc1 b sk_live_x2 c", "#")).toBe("a # b # c");
    expect(compileLinearRegex("a|ab")?.replaceAll("xab", "#")).toBe("x#");
    expect(compileLinearRegex("\\d{3}-\\d{2}")?.replaceAll("ssn 123-45 ok", "#")).toBe("ssn # ok");
  });

  it("matches anchors and word boundaries like JavaScript", () => {
    const regex = compileLinearRegex("^token$");

    expect(regex?.test("token")).toBe(true);
    expect(regex?.test("tokens")).toBe(false);
    expect(compileLinearRegex("\\bpin\\b")?.replaceAll("pin spinner pin", "#")).toBe("# spinner #");
  });

  it("skips empty matches without looping", () => {
    expect(compileLinearRegex("x*")?.replaceAll("abc", "#")).toBe("abc");
  });

  it("masks the union of all matches, so no part of a longer match is left out", () => {
    expect(compileLinearRegex("abcdef|cd")?.replaceAll("abcdef", "#")).toBe("#");
    expect(compileLinearRegex("ab|bc")?.replaceAll("xabcx", "#")).toBe("x#x");
  });

  it("stays linear when a long alternative keeps an attempt alive after every match", () => {
    const regex = compileLinearRegex("x\\w*y|x");
    const run = (size: number) => () => regex?.replaceAll("x".repeat(size), "#");
    const smallMs = fastestRunMs(run(2_000), 7);
    const largeMs = fastestRunMs(run(2_000 * LINEAR_INPUT_FACTOR), 3);

    expect(regex?.replaceAll("xxx", "#")).toBe("#");
    expect(largeMs / Math.max(smallMs, 0.05)).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });

  it("masks the whole text instead of stalling when a scan runs out of budget", () => {
    const regex = compileLinearRegex("[a-z]{250}x");
    const text = "b".repeat(200_000);
    const started = performance.now();

    expect(regex?.replaceAll(text, "#")).toBe("#");
    expect(regex?.test(text)).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(regex?.replaceAll("b".repeat(300), "#")).toBe("b".repeat(300));
  });

  it("counts the states visited at every position, not only the live threads", () => {
    // Every alternative dies on `^` after the first position: few threads, much closure work.
    const regex = compileLinearRegex(
      Array.from({ length: 150 }, (_, index) => `^abc${index}`).join("|")
    );
    const text = "z".repeat(1_000_000);
    const started = performance.now();

    expect(regex?.replaceAll(text, "#")).toBe("#");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(regex?.replaceAll("abc7 zz", "#")).toBe("# zz");
  });

  it("rejects programs above the requested size", () => {
    expect(compileLinearRegex("[a-z]{300}", { maxProgramSize: 256 })).toBeNull();
    expect(compileLinearRegex("[a-z]{30}", { maxProgramSize: 256 })).not.toBeNull();
  });

  it("stays linear on catastrophic patterns", () => {
    const regex = compileLinearRegex("(a+)+$");
    const run = (size: number) => () => regex?.replaceAll(`${"a".repeat(size)}!`, "#");
    const smallMs = fastestRunMs(run(2_000), 7);
    const largeMs = fastestRunMs(run(2_000 * LINEAR_INPUT_FACTOR), 3);

    expect(largeMs / Math.max(smallMs, 0.05)).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });
});
