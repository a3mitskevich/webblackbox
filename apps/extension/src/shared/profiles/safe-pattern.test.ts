import { describe, expect, it } from "vitest";

import { isSafeRegexSource, matchesGlob } from "./safe-pattern.js";

const SLOW_MATCH_MS = 250;

function elapsedMs(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("matchesGlob", () => {
  it("matches * within a segment and ** across segments", () => {
    expect(matchesGlob("/app/orders", "/app/*")).toBe(true);
    expect(matchesGlob("/app/orders/42", "/app/*")).toBe(false);
    expect(matchesGlob("/app/orders/42", "/app/**")).toBe(true);
    expect(matchesGlob("/app/a.b", "/app/a.b")).toBe(true);
    expect(matchesGlob("/app/aXb", "/app/a.b")).toBe(false);
    expect(matchesGlob("/", "**")).toBe(true);
    expect(matchesGlob("", "")).toBe(true);
  });

  it("stays fast on patterns that backtrack catastrophically as a regex", () => {
    const pattern = `${"**a".repeat(12)}**b`;
    const path = `/${"a".repeat(2_000)}`;

    expect(elapsedMs(() => matchesGlob(path, pattern))).toBeLessThan(SLOW_MATCH_MS);
    expect(matchesGlob(path, pattern)).toBe(false);
  });
});

describe("isSafeRegexSource", () => {
  it("accepts ordinary title patterns", () => {
    for (const source of [
      "staging",
      "^Admin.*Dashboard$",
      "(orders|invoices) - acme",
      "[a-z]+ \\(beta\\)",
      "(?:qa|uat)\\b",
      "(?<env>dev) build"
    ]) {
      expect(isSafeRegexSource(source), source).toBe(true);
    }
  });

  it("rejects nested or alternated quantified groups and backreferences", () => {
    for (const source of [
      "^(a+)+$",
      "(a*)*b",
      "(a|aa)+",
      "((ab)*c)+",
      "(\\w+\\s?){3,}",
      "(a)\\1",
      "(?<x>a)\\k<x>",
      ".*a.*b.*c",
      "(?:a.*){1}a*b",
      "(unclosed"
    ]) {
      expect(isSafeRegexSource(source), source).toBe(false);
    }
  });

  it("keeps the slowest accepted patterns fast on a maximum-length title", () => {
    const title = "a".repeat(256);

    for (const source of [".*a.*b", "a+a+b", "[a-z]*a*b"]) {
      expect(isSafeRegexSource(source), source).toBe(true);
      expect(
        elapsedMs(() => new RegExp(source, "i").test(title)),
        source
      ).toBeLessThan(SLOW_MATCH_MS);
    }
  });
});
