#!/usr/bin/env node
// The MCP evaluation: for every recorded archive, an agent that only has the WebBlackbox MCP
// server reads the tester's report and the archive, names the root cause and its evidence, and
// the answer is scored against the scenario rubric. Writes a Markdown + JSON report.
//
//   pnpm --filter @webblackbox/evals eval [--model sonnet] [--lang ru|en] [--label baseline]
//     [--scenario <id|case>]... [--profile <id>]... [--judge] [--concurrency 2]
//
// Needs `pnpm build` (the MCP server), recorded archives (`record`), and the `claude` CLI.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runAgent } from "./agent-runner.js";
import { inspectArchive } from "./archive-facts.js";
import { type ArchiveManifest, type ManifestEntry, readManifest } from "./archive-manifest.js";
import { judgeAnswer } from "./judge.js";
import {
  ARCHIVE_MANIFEST,
  ARCHIVES_DIR,
  MCP_SERVER_CLI,
  REPO_ROOT,
  REPORTS_DIR,
  RUNS_DIR
} from "./paths.js";
import { fillTemplate, loadPrompt } from "./prompts.js";
import { type EvalReport, type EvalResult, renderMarkdown, totalsByProfile } from "./report.js";
import { parseAgentAnswer, scoreAnswer } from "./rubric.js";
import { selectScenarios } from "./scenarios/index.js";
import type { Scenario } from "./types.js";

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_BUDGET_USD = 3;
const MCP_SERVER_NAME = "webblackbox";

type Options = {
  archivesDir: string;
  model: string;
  judgeModel: string | null;
  lang: "ru" | "en";
  label: string;
  reportDir: string;
  concurrency: number;
  timeoutMs: number;
  maxBudgetUsd: number;
  extraArgs: readonly string[];
};

type RunContext = { runDir: string; agentCwd: string; mcpConfigPath: string };

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      archives: { type: "string", default: ARCHIVES_DIR },
      scenario: { type: "string", multiple: true, default: [] },
      profile: { type: "string", multiple: true, default: [] },
      model: { type: "string", default: process.env.WB_EVAL_MODEL ?? DEFAULT_MODEL },
      judge: { type: "boolean", default: false },
      "judge-model": { type: "string" },
      lang: { type: "string", default: "ru" },
      label: { type: "string", default: "run" },
      "report-dir": { type: "string", default: REPORTS_DIR },
      concurrency: { type: "string", default: "2" },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      "max-budget-usd": { type: "string", default: String(DEFAULT_MAX_BUDGET_USD) },
      bare: { type: "boolean", default: false }
    }
  });

  if (values.lang !== "ru" && values.lang !== "en") {
    throw new Error("--lang must be ru or en");
  }

  const options: Options = {
    archivesDir: resolve(values.archives),
    model: values.model,
    judgeModel: values.judge ? (values["judge-model"] ?? values.model) : null,
    lang: values.lang,
    label: values.label.replace(/[^\w.-]+/g, "-"),
    reportDir: resolve(values["report-dir"]),
    concurrency: positiveInt(values.concurrency, "--concurrency"),
    timeoutMs: positiveInt(values["timeout-ms"], "--timeout-ms"),
    maxBudgetUsd: positiveNumber(values["max-budget-usd"], "--max-budget-usd"),
    extraArgs: values.bare ? ["--bare"] : []
  };
  const manifest = await readManifest(join(options.archivesDir, ARCHIVE_MANIFEST));

  if (!manifest) {
    throw new Error(`No archives in ${options.archivesDir}: run the recorder first`);
  }

  const scenarios = selectScenarios(values.scenario);
  const entries = manifest.entries.filter(
    (entry) =>
      !entry.error &&
      scenarios.some((scenario) => scenario.id === entry.scenarioId) &&
      (values.profile.length === 0 || values.profile.includes(entry.profile))
  );

  if (entries.length === 0) {
    throw new Error("No recorded archives match the selection");
  }

  const startedAt = new Date();
  const runDir = join(
    RUNS_DIR,
    `${startedAt.toISOString().replace(/[:.]/g, "-")}-${options.label}`
  );
  const context: RunContext = {
    runDir,
    agentCwd: join(runDir, "cwd"),
    mcpConfigPath: join(runDir, "mcp.json")
  };
  await mkdir(context.agentCwd, { recursive: true });
  await writeFile(context.mcpConfigPath, JSON.stringify(mcpConfig(options.archivesDir), null, 2));

  console.log(
    `Evaluating ${entries.length} archive(s) with ${options.model}; transcripts: ${runDir}`
  );
  const results = await mapWithConcurrency(entries, options.concurrency, async (entry) => {
    const scenario = scenarios.find((candidate) => candidate.id === entry.scenarioId);

    if (!scenario) {
      throw new Error(`Scenario ${entry.scenarioId} is not defined`);
    }

    const result = await evaluateEntry(entry, scenario, manifest, options, context);
    console.log(formatProgress(result));
    return result;
  });

  const report: EvalReport = {
    meta: {
      label: options.label,
      date: startedAt.toISOString().slice(0, 10),
      commit: gitHead(),
      requestedModel: options.model,
      lang: options.lang,
      judgeModel: options.judgeModel,
      archivesRecordedAt: manifest.createdAt
    },
    results: [...results].sort((a, b) =>
      `${a.caseId}/${a.profile}`.localeCompare(`${b.caseId}/${b.profile}`)
    )
  };
  const base = join(options.reportDir, `${report.meta.date}-${options.label}`);
  await mkdir(options.reportDir, { recursive: true });
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${base}.md`, renderMarkdown(report));

  for (const total of totalsByProfile(report.results)) {
    console.log(
      `${total.profile}: ${total.passed}/${total.runs} passed, mean score ${total.meanScore}, ` +
        `$${total.costUsd}`
    );
  }

  console.log(`Report: ${base}.md`);
}

async function evaluateEntry(
  entry: ManifestEntry,
  scenario: Scenario,
  manifest: ArchiveManifest,
  options: Options,
  context: RunContext
): Promise<EvalResult> {
  const archivePath = join(options.archivesDir, entry.file);
  const prompt = fillTemplate(await loadPrompt("agent-task"), {
    report: scenario.report[options.lang],
    archivePath,
    passphrase: manifest.passphrase
  });
  const agentRun = await runAgent({
    prompt,
    systemPrompt: await loadPrompt("agent-system"),
    model: options.model,
    mcpConfigPath: context.mcpConfigPath,
    allowedTools: [`mcp__${MCP_SERVER_NAME}`],
    cwd: context.agentCwd,
    timeoutMs: options.timeoutMs,
    maxBudgetUsd: options.maxBudgetUsd,
    extraArgs: options.extraArgs
  });
  await writeFile(
    join(context.runDir, `${entry.profile}-${entry.caseId}.jsonl`),
    agentRun.transcript
  );

  const answer = parseAgentAnswer(agentRun.text);
  const score = scoreAnswer(answer, scenario.rubric);
  const judge =
    options.judgeModel && score.partial
      ? await judgeAnswer(answer, scenario.rubric, {
          model: options.judgeModel,
          cwd: context.agentCwd,
          extraArgs: options.extraArgs
        })
      : undefined;
  const facts = await inspectArchive(archivePath, manifest.passphrase).catch((error: unknown) => {
    console.warn(`  could not inspect ${archivePath}: ${String(error)}`);
    return null;
  });

  return {
    caseId: entry.caseId,
    scenarioId: scenario.id,
    title: scenario.title,
    profile: entry.profile,
    model: agentRun.model,
    pass: judge ? judge.pass : score.pass,
    rubricPass: score.pass,
    partial: score.partial,
    score: score.score,
    required: score.required,
    bonus: score.bonus,
    forbidden: score.forbidden,
    ...(judge ? { judge: { pass: judge.pass, reason: judge.reason } } : {}),
    answer,
    toolCalls: agentRun.toolCalls,
    toolCallCount: agentRun.toolCallCount,
    tokens: agentRun.tokens,
    costUsd: agentRun.costUsd + (judge?.costUsd ?? 0),
    durationMs: agentRun.durationMs,
    turns: agentRun.turns,
    evidence: Object.fromEntries(scenario.evidence.map((kind) => [kind, facts?.[kind] ?? null])),
    ...(agentRun.error ? { error: agentRun.error } : {})
  };
}

function formatProgress(result: EvalResult): string {
  return (
    `[${result.profile}] ${result.caseId} ${result.scenarioId}: ${result.pass ? "PASS" : "FAIL"} ` +
    `score ${result.score} · ${result.toolCallCount} tool calls · ${result.tokens.total} tokens · ` +
    `$${result.costUsd.toFixed(2)} · ${Math.round(result.durationMs / 1000)} s` +
    (result.error ? ` · ERROR ${result.error}` : "")
  );
}

/** Only our MCP server, limited to the archives directory. */
function mcpConfig(archivesDir: string): object {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [MCP_SERVER_CLI, "--allow-dir", archivesDir]
      }
    }
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }

  return parsed;
}

function positiveNumber(value: string, flag: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }

  return parsed;
}
