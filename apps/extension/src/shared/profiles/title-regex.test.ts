import { describe, expect, it } from "vitest";

import { compileTitleRegex, MAX_MATCHED_TITLE_LENGTH } from "./title-regex.js";

/**
 * Catastrophic backtracking on a 256-character title takes seconds to years, so this budget
 * separates it from a busy shared CI runner (one 50 ms limit measured 50.4 ms there).
 */
const FAST_MATCH_MS = 250;
const TIMED_RUNS = 5;
const FUZZ_PATTERNS = 3_000;
const FUZZ_TITLES_PER_PATTERN = 12;

/** Deterministic PRNG (mulberry32) so a failing fuzz case is reproducible. */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

const ATOMS = [
  "a",
  "b",
  "A",
  " ",
  "-",
  ".",
  "[ab]",
  "[^a]",
  "[A-B]",
  "\\w",
  "\\d",
  "\\s",
  "\\.",
  "{",
  "]"
];
const QUANTIFIERS = ["", "", "", "*", "+", "?", "{2}", "{1,3}", "{0,}", "*?", "+?"];
const ASSERTIONS = ["^", "$", "\\b", "\\B"];

function randomPattern(random: () => number, depth = 0): string {
  const length = 1 + Math.floor(random() * 4);
  let pattern = "";

  for (let index = 0; index < length; index += 1) {
    const roll = random();

    if (roll < 0.1) {
      pattern += pick(random, ASSERTIONS);
      continue;
    }

    const atom =
      roll < 0.3 && depth < 2
        ? `(${random() < 0.5 ? "?:" : ""}${randomPattern(random, depth + 1)}${
            random() < 0.5 ? `|${randomPattern(random, depth + 1)}` : ""
          })`
        : pick(random, ATOMS);
    pattern += atom + pick(random, QUANTIFIERS);
  }

  return random() < 0.15 ? `${pattern}|${randomPattern(random, depth + 1)}` : pattern;
}

function randomTitle(random: () => number): string {
  const length = Math.floor(random() * 10);
  return Array.from({ length }, () => pick(random, ["a", "A", "b", " ", "1", "-", ".", "_"])).join(
    ""
  );
}

/** The fastest of several runs: CPU contention only ever adds time, so the minimum is stable. */
function fastestRunMs(run: () => unknown): number {
  let fastest = Number.POSITIVE_INFINITY;

  for (let index = 0; index < TIMED_RUNS; index += 1) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }

  return fastest;
}

describe("compileTitleRegex", () => {
  it("agrees with JavaScript regular expressions (differential fuzz)", () => {
    const random = createRandom(0x5eed);
    let compared = 0;

    for (let index = 0; index < FUZZ_PATTERNS; index += 1) {
      const source = randomPattern(random);
      let native: RegExp;

      try {
        native = new RegExp(source, "i");
      } catch {
        expect(compileTitleRegex(source), source).toBeNull();
        continue;
      }

      const matcher = compileTitleRegex(source);
      expect(matcher, source).not.toBeNull();

      for (let titleIndex = 0; titleIndex < FUZZ_TITLES_PER_PATTERN; titleIndex += 1) {
        const title = randomTitle(random);
        expect(matcher?.(title), `${source} on "${title}"`).toBe(native.test(title));
        compared += 1;
      }
    }

    expect(compared).toBeGreaterThan(FUZZ_PATTERNS * FUZZ_TITLES_PER_PATTERN * 0.5);
  });

  it("matches everyday title rules case-insensitively", () => {
    const matches = (source: string, title: string) => compileTitleRegex(source)?.(title);

    expect(matches("^Admin.*Dashboard$", "admin – Sales dashboard")).toBe(true);
    expect(matches("(orders|invoices) - acme", "Invoices - ACME")).toBe(true);
    expect(matches("\\bstaging\\b", "my-staging env")).toBe(true);
    expect(matches("\\bstaging\\b", "prestaging")).toBe(false);
    expect(matches("order #\\d{3,5}", "Order #12345")).toBe(true);
    expect(matches("(?<env>qa|uat) build", "UAT build 7")).toBe(true);
  });

  it("stays linear on patterns that backtrack catastrophically in JavaScript", () => {
    const title = `${"a".repeat(MAX_MATCHED_TITLE_LENGTH - 1)}!`;

    for (const source of [
      "^(a+)+$",
      "(a|aa)+$",
      "((a|aa))+$",
      "(?:(?:a|a))*$",
      "(\\w+\\s?)+$",
      ".*a.*a.*a.*a.*z",
      `${".?".repeat(14)}[^z]{64}z`,
      `${"a?".repeat(30)}${"a".repeat(30)}z`,
      "a{0,256}a{0,256}a{0,256}a{0,256}z"
    ]) {
      const matcher = compileTitleRegex(source);

      expect(matcher, source).not.toBeNull();
      expect(
        fastestRunMs(() => matcher?.(title)),
        source
      ).toBeLessThan(FAST_MATCH_MS);
    }
  });

  it("rejects syntax it cannot match in linear time, and oversized programs", () => {
    const rejected = [
      "(a)\\1",
      "(?<x>a)\\k<x>",
      "(?=.*a)b",
      "(?!a)b",
      "(?<=a)b",
      "(?<!a)b",
      "((a{60}){60}){60}",
      "(((((){99}){99}){99}){99}){99}",
      "((((((?:){99}){99}){99}){99}){99}){99}",
      "(unclosed",
      "*a"
    ];

    for (const source of rejected) {
      expect(compileTitleRegex(source), source).toBeNull();
    }

    expect(fastestRunMs(() => rejected.map((source) => compileTitleRegex(source)))).toBeLessThan(
      FAST_MATCH_MS
    );
  });
});
