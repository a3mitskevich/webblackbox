import { describe, expect, it } from "vitest";

import { matchesGlob } from "./safe-pattern.js";

const SLOW_MATCH_MS = 250;

/**
 * Fastest of a few runs in process CPU time: other load on the machine (since #27 every package's
 * tests run at once) and a GC pause or JIT warm-up in one run do not count. Catastrophic
 * backtracking still takes seconds.
 */
function elapsedMs(run: () => unknown, runs = 3): number {
  let fastest = Number.POSITIVE_INFINITY;

  for (let index = 0; index < runs; index += 1) {
    const startedAt = process.cpuUsage();
    run();
    const used = process.cpuUsage(startedAt);
    fastest = Math.min(fastest, (used.user + used.system) / 1_000);
  }

  return fastest;
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
