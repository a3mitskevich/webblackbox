import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateAbsoluteBudget,
  evaluateDelta,
  findSizeIncreaseNote,
  formatPercent,
  parseBaselineReport,
  parseBudgetConfig,
  parseSizeIncreaseNotes
} from "./bundle-size.mjs";

const POLICY = {
  maxGrowthPercent: 8,
  minGrowthBytes: 2048,
  entries: ["apps/extension/build/sw.js"]
};
const SW = "apps/extension/build/sw.js";

describe("parseBudgetConfig", () => {
  it("accepts absolute budgets and a delta policy", () => {
    const config = parseBudgetConfig({
      absolute: [{ path: "a.js", maxBytes: 10, forbidSources: ["node_modules/zod/"] }],
      delta: POLICY
    });

    assert.deepEqual(config.absolute, [
      {
        path: "a.js",
        maxBytes: 10,
        maxGzipBytes: undefined,
        forbidSources: ["node_modules/zod/"],
        note: undefined
      }
    ]);
    assert.deepEqual(config.delta, POLICY);
  });

  it("rejects budgets that check nothing or carry bad numbers", () => {
    assert.throws(() => parseBudgetConfig({}), /declares no bundles/);
    assert.throws(() => parseBudgetConfig({ absolute: [{ path: "a.js" }] }), /needs maxBytes/);
    assert.throws(
      () => parseBudgetConfig({ absolute: [{ path: "a.js", maxBytes: -1 }] }),
      /positive integer/
    );
    assert.throws(
      () => parseBudgetConfig({ delta: { ...POLICY, minGrowthBytes: "2k" } }),
      /minGrowthBytes/
    );
    assert.throws(() => parseBudgetConfig({ delta: { ...POLICY, entries: [""] } }), /bundle paths/);
  });
});

describe("parseBaselineReport", () => {
  it("indexes valid rows by path and skips malformed ones", () => {
    const baseline = parseBaselineReport({
      report: [
        { path: SW, bytes: 100, gzipBytes: 40, kind: "delta" },
        { path: "broken.js", bytes: "100", gzipBytes: 40 },
        null
      ]
    });

    assert.deepEqual([...baseline.keys()], [SW]);
    assert.deepEqual(baseline.get(SW), { path: SW, bytes: 100, gzipBytes: 40 });
  });

  it("rejects a file that is not a report", () => {
    assert.throws(() => parseBaselineReport({ entries: [] }), /no `report` array/);
  });
});

describe("size-increase notes", () => {
  it("parses notes from commit messages and PR bodies, case-insensitively", () => {
    const notes = parseSizeIncreaseNotes(
      [
        "feat(extension): offscreen bridge",
        "",
        "size-increase: sw.js typed offscreen protocol",
        "Size-Increase: apps/player/build/main.js: React shell",
        "  size-increase: *   everything got bigger",
        "size-increase: no-reason-given",
        "not a size-increase: line"
      ].join("\r\n")
    );

    assert.deepEqual(notes, [
      { target: "sw.js", reason: "typed offscreen protocol" },
      { target: "apps/player/build/main.js", reason: "React shell" },
      { target: "*", reason: "everything got bigger" }
    ]);
  });

  it("matches a note by full path, by file name or by `*`", () => {
    const byName = [{ target: "sw.js", reason: "r" }];
    const byPath = [{ target: SW, reason: "r" }];
    const all = [{ target: "*", reason: "r" }];
    const other = [{ target: "offscreen.js", reason: "r" }];

    assert.equal(findSizeIncreaseNote(byName, SW), byName[0]);
    assert.equal(findSizeIncreaseNote(byPath, SW), byPath[0]);
    assert.equal(findSizeIncreaseNote(all, SW), all[0]);
    assert.equal(findSizeIncreaseNote(other, SW), undefined);
  });
});

describe("evaluateAbsoluteBudget", () => {
  const budget = {
    path: "injected.js",
    maxBytes: 1000,
    maxGzipBytes: 400,
    forbidSources: ["node_modules/zod/"]
  };

  it("passes a bundle inside its budget without forbidden sources", () => {
    assert.deepEqual(
      evaluateAbsoluteBudget(budget, { path: "injected.js", bytes: 1000, gzipBytes: 400 }, [
        "../src/a.ts"
      ]),
      []
    );
  });

  it("reports raw, gzip and forbidden-source violations", () => {
    const failures = evaluateAbsoluteBudget(
      budget,
      { path: "injected.js", bytes: 1001, gzipBytes: 401 },
      ["../src/a.ts", "../../node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/core.js"]
    );

    assert.equal(failures.length, 3);
    assert.match(failures[0], /raw size 1001 exceeds budget 1000 \(\+1\)/);
    assert.match(failures[1], /gzip size 401 exceeds budget 400 \(\+1\)/);
    assert.match(failures[2], /1 forbidden source\(s\) matching "node_modules\/zod\/"/);
  });

  it("fails closed when the sourcemap needed for the source check is missing", () => {
    const failures = evaluateAbsoluteBudget(
      budget,
      { path: "injected.js", bytes: 1, gzipBytes: 1 },
      null
    );

    assert.deepEqual(failures, ["injected.js: no sourcemap, cannot check forbidden sources"]);
  });
});

describe("evaluateDelta", () => {
  const base = { path: SW, bytes: 100_000, gzipBytes: 30_000 };

  it("treats a bundle missing from the baseline as new", () => {
    assert.equal(evaluateDelta(POLICY, { ...base }, undefined, []).status, "new");
  });

  it("allows growth up to the percentage threshold, and shrinking", () => {
    assert.equal(evaluateDelta(POLICY, { ...base, bytes: 108_000 }, base, []).status, "ok");
    assert.equal(evaluateDelta(POLICY, { ...base, bytes: 50_000 }, base, []).status, "ok");
  });

  it("uses the byte floor for small bundles", () => {
    const small = { path: SW, bytes: 1_000, gzipBytes: 500 };

    assert.equal(evaluateDelta(POLICY, { ...small, bytes: 3_048 }, small, []).status, "ok");
    assert.equal(evaluateDelta(POLICY, { ...small, bytes: 3_049 }, small, []).status, "failed");
  });

  it("fails unexplained growth above the threshold with a hint", () => {
    const result = evaluateDelta(POLICY, { ...base, bytes: 108_001 }, base, []);

    assert.equal(result.status, "failed");
    assert.equal(result.growthBytes, 8_001);
    assert.equal(result.limitBytes, 8_000);
    assert.match(result.message ?? "", /size-increase: sw\.js <reason>/);
  });

  it("accepts growth explained by a note", () => {
    const result = evaluateDelta(POLICY, { ...base, bytes: 150_000 }, base, [
      { target: "sw.js", reason: "typed offscreen protocol" }
    ]);

    assert.equal(result.status, "explained");
    assert.equal(result.reason, "typed offscreen protocol");
  });
});

describe("formatPercent", () => {
  it("formats signed percentages and guards a zero base", () => {
    assert.equal(formatPercent(8, 100), "+8.0%");
    assert.equal(formatPercent(-25, 100), "-25.0%");
    assert.equal(formatPercent(5, 0), "n/a");
  });
});
