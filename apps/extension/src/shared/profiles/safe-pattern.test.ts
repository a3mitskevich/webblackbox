import { describe, expect, it } from "vitest";

import { matchesGlob } from "./safe-pattern.js";

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
