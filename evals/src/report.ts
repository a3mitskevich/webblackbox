// The evaluation report: per run pass/fail, score, tools, tokens and time; totals per profile;
// and the data each failed analysis lacked. Rendered as JSON (for tooling) and Markdown.

import type { TokenUsage } from "./agent-runner.js";
import type { JudgeVerdict } from "./judge.js";
import { type AgentAnswer, type FactResult, scoreAnswer } from "./rubric.js";
import type { Rubric } from "./types.js";

export type EvalResult = {
  caseId: string;
  scenarioId: string;
  title: string;
  profile: string;
  model: string;
  /** Final verdict: the rubric's, or the judge's when the rubric was undecided. */
  pass: boolean;
  rubricPass: boolean;
  partial: boolean;
  score: number;
  required: readonly FactResult[];
  bonus: readonly FactResult[];
  forbidden: readonly FactResult[];
  judge?: Omit<JudgeVerdict, "costUsd">;
  answer: AgentAnswer;
  toolCalls: Readonly<Record<string, number>>;
  toolCallCount: number;
  tokens: TokenUsage;
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Evidence kinds the scenario needs: present in the archive, missing, or null (not checked). */
  evidence: Readonly<Record<string, boolean | null>>;
  error?: string;
};

export type ReportMeta = {
  label: string;
  date: string;
  commit: string;
  requestedModel: string;
  lang: "ru" | "en";
  judgeModel: string | null;
  archivesRecordedAt: string;
};

export type EvalReport = { meta: ReportMeta; results: readonly EvalResult[] };

export type ProfileTotals = {
  profile: string;
  runs: number;
  passed: number;
  passRate: number;
  meanScore: number;
  medianTokens: number;
  totalTokens: number;
  costUsd: number;
  meanDurationMs: number;
  meanToolCalls: number;
  errors: number;
};

const PROFILE_LABELS: Readonly<Record<string, string>> = {
  maximum: "Maximum (default)",
  light: "Light",
  // Reports recorded before Maximum and Light became the built-in profiles.
  default: "Default (Lite)",
  "full-capture": "Full capture"
};

/**
 * The same answer scored with the (possibly updated) rubric. A judge verdict is kept only while
 * the rubric still leaves the answer undecided.
 */
export function rescoreResult(result: EvalResult, rubric: Rubric): EvalResult {
  const score = scoreAnswer(result.answer, rubric);
  const judge = score.partial ? result.judge : undefined;
  return {
    ...result,
    pass: judge ? judge.pass : score.pass,
    rubricPass: score.pass,
    partial: score.partial,
    score: score.score,
    required: score.required,
    bonus: score.bonus,
    forbidden: score.forbidden,
    judge
  };
}

/** Reads a report written by the runner; only the shape the re-scoring relies on is checked. */
export function parseReport(value: unknown): EvalReport {
  const report = value as Partial<EvalReport> | null;

  if (
    !report ||
    typeof report.meta !== "object" ||
    !Array.isArray(report.results) ||
    !report.results.every(
      (result) =>
        typeof result?.scenarioId === "string" && typeof result.answer?.rootCause === "string"
    )
  ) {
    throw new Error("Not an evaluation report");
  }

  return report as EvalReport;
}

export function totalsByProfile(results: readonly EvalResult[]): readonly ProfileTotals[] {
  const profiles = [...new Set(results.map((result) => result.profile))];

  return profiles.map((profile) => {
    const runs = results.filter((result) => result.profile === profile);
    const passed = runs.filter((result) => result.pass).length;
    const tokens = runs.map((result) => result.tokens.total);

    return {
      profile,
      runs: runs.length,
      passed,
      passRate: ratio(passed, runs.length),
      meanScore: mean(runs.map((result) => result.score)),
      medianTokens: median(tokens),
      totalTokens: tokens.reduce((sum, value) => sum + value, 0),
      costUsd: round(
        runs.reduce((sum, result) => sum + result.costUsd, 0),
        2
      ),
      meanDurationMs: Math.round(mean(runs.map((result) => result.durationMs))),
      meanToolCalls: mean(runs.map((result) => result.toolCallCount)),
      errors: runs.filter((result) => result.error).length
    };
  });
}

export function renderMarkdown(report: EvalReport): string {
  const { meta, results } = report;
  const totals = totalsByProfile(results);
  const profiles = totals.map((total) => total.profile);
  const models = [...new Set(results.map((result) => result.model))].join(", ") || "n/a";
  const cost = round(
    results.reduce((sum, result) => sum + result.costUsd, 0),
    2
  );
  const judge = meta.judgeModel
    ? `\`${meta.judgeModel}\` (only for partial rubric matches)`
    : "off (rubric only)";

  return [
    `# MCP evaluation — ${meta.label} (${meta.date})`,
    "",
    `- Commit: \`${meta.commit}\``,
    `- Agent model: ${models} (requested \`${meta.requestedModel}\`)`,
    `- Tester reports: ${meta.lang === "ru" ? "Russian" : "English"}`,
    `- Judge: ${judge}`,
    `- Archives recorded: ${meta.archivesRecordedAt}`,
    `- Runs: ${results.length}; total cost: $${cost.toFixed(2)}`,
    "",
    "## Totals per profile",
    "",
    "| Profile | Passed | Pass rate | Mean score | Median tokens | Mean tool calls | Mean time | Cost | Errors |",
    "|---|---|---|---|---|---|---|---|---|",
    ...totals.map(
      (total) =>
        `| ${profileLabel(total.profile)} | ${total.passed}/${total.runs} | ${percent(total.passRate)} | ` +
        `${total.meanScore.toFixed(2)} | ${formatTokens(total.medianTokens)} | ` +
        `${total.meanToolCalls.toFixed(1)} | ${formatSeconds(total.meanDurationMs)} | ` +
        `$${total.costUsd.toFixed(2)} | ${total.errors} |`
    ),
    "",
    "## Results per scenario",
    "",
    `| Case | Scenario | ${profiles.map(profileLabel).join(" | ")} |`,
    `|---|---|${profiles.map(() => "---").join("|")}|`,
    ...scenarioRows(results, profiles),
    "",
    "Cell: verdict, rubric score (0–1), tokens, time. ✅ pass · ❌ fail · ⚖️ judge decided · ⚠️ run error.",
    "",
    "## Tools used (calls)",
    "",
    `| Tool | ${profiles.map(profileLabel).join(" | ")} |`,
    `|---|${profiles.map(() => "---").join("|")}|`,
    ...toolRows(results, profiles),
    "",
    "## Data in the archives",
    "",
    "Evidence each scenario needs: ✓ present in the archive, ✗ missing, ? not checked.",
    "",
    `| Case | ${profiles.map(profileLabel).join(" | ")} |`,
    `|---|${profiles.map(() => "---").join("|")}|`,
    ...evidenceRows(results, profiles),
    "",
    ...failureDetails(results),
    ""
  ].join("\n");
}

function scenarioRows(results: readonly EvalResult[], profiles: readonly string[]): string[] {
  return groupByCase(results).map(([caseId, runs]) => {
    const cells = profiles.map((profile) => {
      const run = runs.find((result) => result.profile === profile);
      return run ? formatCell(run) : "—";
    });
    return `| ${caseId} | ${runs[0]?.title ?? ""} | ${cells.join(" | ")} |`;
  });
}

function toolRows(results: readonly EvalResult[], profiles: readonly string[]): string[] {
  const tools = [...new Set(results.flatMap((result) => Object.keys(result.toolCalls)))].sort();

  return tools.map((tool) => {
    const cells = profiles.map((profile) =>
      String(
        results
          .filter((result) => result.profile === profile)
          .reduce((sum, result) => sum + (result.toolCalls[tool] ?? 0), 0)
      )
    );
    return `| \`${tool}\` | ${cells.join(" | ")} |`;
  });
}

function evidenceRows(results: readonly EvalResult[], profiles: readonly string[]): string[] {
  return groupByCase(results).map(([caseId, runs]) => {
    const cells = profiles.map((profile) => {
      const run = runs.find((result) => result.profile === profile);
      return run
        ? Object.entries(run.evidence)
            .map(([kind, present]) => `${formatPresence(present)} ${kind}`)
            .join("<br>")
        : "—";
    });
    return `| ${caseId} | ${cells.join(" | ")} |`;
  });
}

function failureDetails(results: readonly EvalResult[]): string[] {
  const failed = results.filter((result) => !result.pass);

  if (failed.length === 0) {
    return ["No failed analyses."];
  }

  return [
    "## Failed analyses",
    "",
    ...failed.flatMap((result) => {
      const missed = result.required.filter((fact) => !fact.matched);
      const wrong = result.forbidden.filter((fact) => fact.matched);
      const absent = Object.entries(result.evidence).filter(([, present]) => present === false);

      return [
        `**${result.caseId} ${result.scenarioId} — ${profileLabel(result.profile)}**`,
        "",
        `- Missed facts: ${listOrNone(missed.map((fact) => fact.description))}`,
        `- Wrong conclusions: ${listOrNone(wrong.map((fact) => fact.description))}`,
        `- Missing in the archive: ${listOrNone(absent.map(([kind]) => kind))}`,
        `- Agent said it lacked: ${listOrNone(result.answer.missingData.map(oneLine))}`,
        `- Agent's root cause: ${oneLine(result.answer.rootCause).slice(0, 400) || "(none)"}`,
        ...(result.judge
          ? [`- Judge: ${result.judge.pass ? "pass" : "fail"} — ${result.judge.reason}`]
          : []),
        ...(result.error ? [`- Run error: ${result.error}`] : []),
        ""
      ];
    })
  ];
}

function groupByCase(results: readonly EvalResult[]): [string, EvalResult[]][] {
  const groups = new Map<string, EvalResult[]>();

  for (const result of results) {
    groups.set(result.caseId, [...(groups.get(result.caseId) ?? []), result]);
  }

  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

function formatCell(result: EvalResult): string {
  const verdict = result.pass ? "✅" : "❌";
  const mark = result.error ? "⚠️" : result.judge ? `⚖️${verdict}` : verdict;

  return (
    `${mark} ${result.score.toFixed(2)} · ${formatTokens(result.tokens.total)} · ` +
    formatSeconds(result.durationMs)
  );
}

function formatPresence(value: boolean | null | undefined): string {
  return value === true ? "✓" : value === false ? "✗" : "?";
}

function profileLabel(profile: string): string {
  return PROFILE_LABELS[profile] ?? profile;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tok` : `${tokens} tok`;
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join("; ") : "none";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : round(part / whole, 2);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
