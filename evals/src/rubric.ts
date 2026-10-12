// Deterministic scoring of an agent's analysis against a scenario rubric. The agent ends its
// answer with a JSON block (see prompts/agent.md); without one, the whole answer text is scored.

import type { Rubric, RubricFact } from "./types.js";

export type AgentAnswer = {
  rootCause: string;
  evidence: readonly string[];
  missingData: readonly string[];
  confidence: string;
  /** False when no valid JSON answer was found and the raw text stands in for it. */
  structured: boolean;
};

export type FactResult = { id: string; description: string; matched: boolean };

export type RubricScore = {
  /** Every required fact matched and no forbidden conclusion in the stated root cause. */
  pass: boolean;
  /** Some, but not all, required facts matched (the only case an LLM judge is asked about). */
  partial: boolean;
  /** 0..1: required facts weigh 1, bonus facts 0.5; 0 when a forbidden conclusion matched. */
  score: number;
  required: readonly FactResult[];
  bonus: readonly FactResult[];
  forbidden: readonly FactResult[];
};

const BONUS_WEIGHT = 0.5;

/** Wrong for every scenario: an answer that opens by declaring the cause unknown names none. */
export const UNDETERMINED_CAUSE: RubricFact = {
  id: "undetermined",
  description: "Declares the root cause undetermined",
  patterns: [
    /^\s*(the )?(recording|data|archive) (does not|doesn't|cannot|can't) (show|reveal|determine) the (root )?cause/i,
    /^\s*(the )?(root )?cause (is |remains )?(unknown|undetermined|not (established|determined))/i,
    /^\s*не установлен/i
  ]
};
const FENCED_BLOCK_PATTERN = /```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi;

/**
 * Extracts the agent's answer: the last fenced block (or, failing that, the last bare object
 * starting at `{"rootCause"`) that parses as JSON with a string `rootCause`. Falls back to the
 * raw text.
 */
export function parseAgentAnswer(text: string): AgentAnswer {
  const fenced = [...text.matchAll(FENCED_BLOCK_PATTERN)].map((match) => match[1] ?? "");
  const bareStart = text.lastIndexOf('{"rootCause"');
  const bare = bareStart >= 0 ? [text.slice(bareStart, text.lastIndexOf("}") + 1)] : [];

  for (const candidate of [...fenced.reverse(), ...bare]) {
    const parsed = parseJsonObject(candidate.trim());

    if (parsed && typeof parsed.rootCause === "string") {
      return {
        rootCause: parsed.rootCause,
        evidence: toStringList(parsed.evidence),
        missingData: toStringList(parsed.missingData),
        confidence: typeof parsed.confidence === "string" ? parsed.confidence : "unknown",
        structured: true
      };
    }
  }

  return {
    rootCause: text,
    evidence: [],
    missingData: [],
    confidence: "unknown",
    structured: false
  };
}

/**
 * Required and bonus facts are looked for in the root cause and the evidence together (unless
 * scoped to the root cause); forbidden conclusions only in the root cause, so evidence that rules
 * something out ("no 500 responses") does not count against the answer.
 */
export function scoreAnswer(answer: AgentAnswer, rubric: Rubric): RubricScore {
  const fullText = [answer.rootCause, ...answer.evidence].join("\n");
  const textFor = (fact: RubricFact) => (fact.scope === "rootCause" ? answer.rootCause : fullText);
  const required = rubric.required.map((fact) => matchFact(fact, textFor(fact)));
  const bonus = rubric.bonus.map((fact) => matchFact(fact, textFor(fact)));
  const forbidden = [...rubric.forbidden, UNDETERMINED_CAUSE].map((fact) =>
    matchFact(fact, answer.rootCause)
  );
  const requiredMatched = required.filter((fact) => fact.matched).length;
  const bonusMatched = bonus.filter((fact) => fact.matched).length;
  const hasForbidden = forbidden.some((fact) => fact.matched);
  const maxPoints = required.length + bonus.length * BONUS_WEIGHT;
  const points = requiredMatched + bonusMatched * BONUS_WEIGHT;
  const allRequired = requiredMatched === required.length;

  return {
    pass: allRequired && !hasForbidden,
    partial: !hasForbidden && requiredMatched > 0 && !allRequired,
    score: hasForbidden || maxPoints === 0 ? 0 : round(points / maxPoints),
    required,
    bonus,
    forbidden
  };
}

function matchFact(fact: RubricFact, text: string): FactResult {
  return {
    id: fact.id,
    description: fact.description,
    // A fresh RegExp per test: a global/sticky pattern would carry `lastIndex` between calls.
    matched: fact.patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(text))
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
