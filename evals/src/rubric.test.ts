import { describe, expect, it } from "vitest";

import { parseAgentAnswer, scoreAnswer } from "./rubric.js";
import type { Rubric } from "./types.js";

const RUBRIC: Rubric = {
  rootCause: "PUT /api/profile answers 500 and the toast is hidden",
  keyEvidence: [],
  required: [
    { id: "status", description: "500", patterns: [/\b500\b/] },
    { id: "endpoint", description: "endpoint", patterns: [/\/api\/profile/i] }
  ],
  bonus: [{ id: "toast", description: "toast", patterns: [/toast/i] }],
  forbidden: [{ id: "no-request", description: "no request", patterns: [/no request/i] }]
};

describe("parseAgentAnswer", () => {
  it("reads the last fenced JSON block", () => {
    const text = [
      "Draft:",
      "```json",
      '{"rootCause": "draft"}',
      "```",
      "Final:",
      "```json",
      '{"rootCause": "PUT /api/profile → 500", "evidence": ["a", 3, "b"], "missingData": ["dom"], "confidence": "high"}',
      "```"
    ].join("\n");

    expect(parseAgentAnswer(text)).toEqual({
      rootCause: "PUT /api/profile → 500",
      evidence: ["a", "b"],
      missingData: ["dom"],
      confidence: "high",
      structured: true
    });
  });

  it("keeps braces inside strings and nested objects", () => {
    const text = '```json\n{"rootCause": "body {zipcode}", "evidence": ["{\\"a\\": 1}"]}\n```';

    expect(parseAgentAnswer(text)).toMatchObject({
      rootCause: "body {zipcode}",
      evidence: ['{"a": 1}'],
      structured: true
    });
  });

  it("accepts a bare JSON answer at the end", () => {
    const text = 'Done.\n{"rootCause": "cache", "evidence": []}';

    expect(parseAgentAnswer(text)).toMatchObject({ rootCause: "cache", structured: true });
  });

  it("skips blocks without a rootCause and falls back to the raw text", () => {
    const text = '```json\n{"note": 1}\n```\nThe cause is a 500 on /api/profile.';
    const answer = parseAgentAnswer(text);

    expect(answer.structured).toBe(false);
    expect(answer.rootCause).toBe(text);
    expect(answer.evidence).toEqual([]);
  });

  it("falls back on malformed JSON", () => {
    expect(parseAgentAnswer('```json\n{"rootCause": \n```').structured).toBe(false);
  });
});

describe("scoreAnswer", () => {
  const answer = (rootCause: string, evidence: string[] = []) => ({
    rootCause,
    evidence,
    missingData: [],
    confidence: "high",
    structured: true
  });

  it("passes when every required fact is stated, with bonus credit", () => {
    const score = scoreAnswer(answer("PUT /api/profile returned 500", ["toast hidden"]), RUBRIC);

    expect(score.pass).toBe(true);
    expect(score.partial).toBe(false);
    expect(score.score).toBe(1);
  });

  it("looks for required facts in the evidence too", () => {
    const score = scoreAnswer(
      answer("The save fails on the server", ["/api/profile → 500"]),
      RUBRIC
    );

    expect(score.pass).toBe(true);
    expect(score.score).toBe(0.8);
  });

  it("is partial when only some required facts match", () => {
    const score = scoreAnswer(answer("Server answered 500"), RUBRIC);

    expect(score.pass).toBe(false);
    expect(score.partial).toBe(true);
    expect(score.score).toBe(0.4);
    expect(score.required.map((fact) => fact.matched)).toEqual([true, false]);
  });

  it("fails and scores zero on a forbidden conclusion in the root cause", () => {
    const score = scoreAnswer(answer("No request was sent; /api/profile 500 elsewhere"), RUBRIC);

    expect(score.pass).toBe(false);
    expect(score.partial).toBe(false);
    expect(score.score).toBe(0);
    expect(score.forbidden[0]?.matched).toBe(true);
  });

  it("ignores forbidden wording that only appears in the evidence", () => {
    const score = scoreAnswer(
      answer("PUT /api/profile returned 500", ["ruled out: no request missing"]),
      RUBRIC
    );

    expect(score.pass).toBe(true);
  });

  it("is not affected by global regex state between calls", () => {
    const rubric: Rubric = {
      ...RUBRIC,
      required: [{ id: "g", description: "g", patterns: [/500/g] }],
      forbidden: []
    };

    expect(scoreAnswer(answer("500"), rubric).pass).toBe(true);
    expect(scoreAnswer(answer("500"), rubric).pass).toBe(true);
  });

  it("looks for a root-cause-scoped fact only in the stated root cause", () => {
    const rubric: Rubric = {
      ...RUBRIC,
      required: [
        { id: "closed", description: "closed", patterns: [/closed/i], scope: "rootCause" }
      ],
      forbidden: []
    };

    expect(scoreAnswer(answer("No updates arrived", ["no socket closed event"]), rubric).pass).toBe(
      false
    );
    expect(scoreAnswer(answer("The socket closed after 1.5 s"), rubric).pass).toBe(true);
  });

  it("fails an answer that opens by declaring the cause undetermined", () => {
    const score = scoreAnswer(
      answer("The recording does not show the cause. Maybe /api/profile 500."),
      RUBRIC
    );

    expect(score.pass).toBe(false);
    expect(score.forbidden.find((fact) => fact.id === "undetermined")?.matched).toBe(true);
    expect(scoreAnswer(answer("Не установлена. /api/profile 500"), RUBRIC).pass).toBe(false);
    expect(
      scoreAnswer(answer("PUT /api/profile returned 500; the exact cause is unknown"), RUBRIC).pass
    ).toBe(true);
  });

  it("fails an empty answer", () => {
    const score = scoreAnswer(answer(""), RUBRIC);

    expect(score.pass).toBe(false);
    expect(score.partial).toBe(false);
    expect(score.score).toBe(0);
  });
});
