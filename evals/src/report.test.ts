import { describe, expect, it } from "vitest";

import {
  type EvalReport,
  type EvalResult,
  parseReport,
  renderMarkdown,
  rescoreResult,
  totalsByProfile
} from "./report.js";
import type { Rubric } from "./types.js";

const result = (overrides: Partial<EvalResult>): EvalResult => ({
  caseId: "case-01",
  scenarioId: "silent-validation",
  title: "Silent validation",
  profile: "default",
  model: "claude-sonnet-x",
  pass: true,
  rubricPass: true,
  partial: false,
  score: 1,
  required: [{ id: "a", description: "Finds A", matched: true }],
  bonus: [],
  forbidden: [{ id: "f", description: "Blames F", matched: false }],
  answer: {
    rootCause: "A | B",
    evidence: [],
    missingData: [],
    confidence: "high",
    structured: true
  },
  toolCalls: { session_summary: 1 },
  toolCallCount: 1,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2_000 },
  costUsd: 0.1,
  durationMs: 10_000,
  turns: 2,
  evidence: { dom: true, "click-target": false },
  ...overrides
});

const META: EvalReport["meta"] = {
  label: "baseline",
  date: "2026-10-12",
  commit: "abc1234",
  requestedModel: "sonnet",
  lang: "ru",
  judgeModel: null,
  archivesRecordedAt: "2026-10-12T00:00:00.000Z"
};

describe("totalsByProfile", () => {
  it("sums passes, cost and tokens per profile", () => {
    const totals = totalsByProfile([
      result({}),
      result({
        caseId: "case-02",
        pass: false,
        score: 0.5,
        tokens: { ...result({}).tokens, total: 4_000 }
      }),
      result({ profile: "full-capture", costUsd: 0.3, error: "boom", pass: false, score: 0 })
    ]);

    expect(totals).toEqual([
      {
        profile: "default",
        runs: 2,
        passed: 1,
        passRate: 0.5,
        meanScore: 0.75,
        medianTokens: 3_000,
        totalTokens: 6_000,
        costUsd: 0.2,
        meanDurationMs: 10_000,
        meanToolCalls: 1,
        errors: 0
      },
      {
        profile: "full-capture",
        runs: 1,
        passed: 0,
        passRate: 0,
        meanScore: 0,
        medianTokens: 2_000,
        totalTokens: 2_000,
        costUsd: 0.3,
        meanDurationMs: 10_000,
        meanToolCalls: 1,
        errors: 1
      }
    ]);
  });
});

describe("renderMarkdown", () => {
  const markdown = renderMarkdown({
    meta: META,
    results: [
      result({}),
      result({
        profile: "full-capture",
        pass: false,
        rubricPass: false,
        partial: true,
        score: 0.4,
        required: [{ id: "a", description: "Finds A", matched: false }],
        answer: {
          rootCause: "Something else",
          evidence: [],
          missingData: ["DOM at click"],
          confidence: "low",
          structured: true
        },
        judge: { pass: false, reason: "different cause" }
      })
    ]
  });

  it("has the header, totals, the scenario matrix, tools and data sections", () => {
    expect(markdown).toContain("# MCP evaluation — baseline (2026-10-12)");
    expect(markdown).toContain("| Default (Lite) | 1/1 | 100% |");
    expect(markdown).toContain("| Full capture | 0/1 | 0% |");
    expect(markdown).toMatch(
      /\| case-01 \| Silent validation \| ✅ 1\.00 · 2k tok · 10 s \| ⚖️❌ 0\.40/
    );
    expect(markdown).toContain("| `session_summary` | 1 | 1 |");
    expect(markdown).toContain("✓ dom<br>✗ click-target");
  });

  it("explains each failed analysis", () => {
    expect(markdown).toContain("**case-01 silent-validation — Full capture**");
    expect(markdown).toContain("- Missed facts: Finds A");
    expect(markdown).toContain("- Missing in the archive: click-target");
    expect(markdown).toContain("- Agent said it lacked: DOM at click");
    expect(markdown).toContain("- Judge: fail — different cause");
  });

  it("escapes table pipes in free text", () => {
    const failed = renderMarkdown({ meta: META, results: [result({ pass: false })] });

    expect(failed).toContain("A \\| B");
  });
});

describe("rescoreResult", () => {
  const rubric: Rubric = {
    rootCause: "",
    keyEvidence: [],
    required: [
      { id: "a", description: "Finds A", patterns: [/\bA\b/] },
      { id: "c", description: "Finds C", patterns: [/\bC\b/] }
    ],
    bonus: [],
    forbidden: []
  };

  it("scores the stored answer with the current rubric and keeps the run data", () => {
    const rescored = rescoreResult(result({ judge: { pass: true, reason: "ok" } }), rubric);

    expect(rescored.partial).toBe(true);
    expect(rescored.pass).toBe(true);
    expect(rescored.judge).toEqual({ pass: true, reason: "ok" });
    expect(rescored.tokens.total).toBe(2_000);
  });

  it("drops a judge verdict once the rubric decides on its own", () => {
    const rescored = rescoreResult(result({ judge: { pass: false, reason: "no" } }), {
      ...rubric,
      required: [rubric.required[0]!]
    });

    expect(rescored.pass).toBe(true);
    expect(rescored.judge).toBeUndefined();
  });

  it("rejects a file that is not a report", () => {
    expect(() => parseReport({ meta: {}, results: [{ scenarioId: 1 }] })).toThrow(/report/);
    expect(parseReport({ meta: META, results: [result({})] }).results).toHaveLength(1);
  });
});
