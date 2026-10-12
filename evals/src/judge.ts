// The LLM judge: asked only when the deterministic rubric is undecided (some, not all, required
// facts matched). Its prompt is evals/prompts/judge.md; it has no tools.

import { runAgent } from "./agent-runner.js";
import { fillTemplate, loadPrompt } from "./prompts.js";
import type { AgentAnswer } from "./rubric.js";
import type { Rubric } from "./types.js";

export type JudgeVerdict = { pass: boolean; reason: string; costUsd: number };

const JUDGE_SYSTEM_PROMPT = "You are a strict, concise grader. Reply with JSON only.";
const JUDGE_TIMEOUT_MS = 180_000;
const JUDGE_MAX_BUDGET_USD = 0.5;

export async function judgeAnswer(
  answer: AgentAnswer,
  rubric: Rubric,
  options: { model: string; cwd: string; extraArgs?: readonly string[] }
): Promise<JudgeVerdict> {
  const prompt = fillTemplate(await loadPrompt("judge"), {
    rootCause: rubric.rootCause,
    keyEvidence: rubric.keyEvidence.map((item) => `- ${item}`).join("\n"),
    answer: JSON.stringify({ rootCause: answer.rootCause, evidence: answer.evidence }, null, 2)
  });
  const run = await runAgent({
    prompt,
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    model: options.model,
    cwd: options.cwd,
    timeoutMs: JUDGE_TIMEOUT_MS,
    maxBudgetUsd: JUDGE_MAX_BUDGET_USD,
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {})
  });

  return { ...parseVerdict(run.text, run.error), costUsd: run.costUsd };
}

/** Reads `{"pass": boolean, "reason": string}`; anything else counts as a fail. */
export function parseVerdict(text: string, error?: string): { pass: boolean; reason: string } {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];

  try {
    const value: unknown = json ? JSON.parse(json) : null;

    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { pass?: unknown }).pass === "boolean"
    ) {
      const { pass, reason } = value as { pass: boolean; reason?: unknown };
      return { pass, reason: typeof reason === "string" ? reason : "" };
    }
  } catch {
    // Fall through: an unreadable verdict counts as a fail.
  }

  return { pass: false, reason: `Unreadable judge verdict${error ? ` (${error})` : ""}` };
}
