#!/usr/bin/env node

// Bundle-size gate. Strict absolute budgets for the bundles loaded into recorded pages, a
// "delta vs base branch" check for everything else. See bundle-size/README.md.
//
//   node scripts/check-bundle-size.mjs [--baseline <report.json>] [--notes-file <file>]

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import {
  evaluateAbsoluteBudget,
  evaluateDelta,
  formatPercent,
  parseBaselineReport,
  parseBudgetConfig,
  parseSizeIncreaseNotes
} from "./lib/bundle-size.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgetsPath = resolve(root, "bundle-size/budgets.json");
const reportPath = resolve(root, "bundle-size/latest-report.json");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const { values } = parseArgs({
    options: {
      baseline: { type: "string" },
      "notes-file": { type: "string" }
    }
  });
  const config = parseBudgetConfig(JSON.parse(await readFile(budgetsPath, "utf8")));
  const baseline = values.baseline
    ? parseBaselineReport(JSON.parse(await readFile(resolve(values.baseline), "utf8")))
    : null;
  const notes = values["notes-file"]
    ? parseSizeIncreaseNotes(await readFile(resolve(values["notes-file"]), "utf8"))
    : [];

  const failures = [];
  const report = [];
  const lines = [];

  for (const budget of config.absolute) {
    const size = await measure(budget.path);
    const sources = budget.forbidSources.length > 0 ? await readSourcemapSources(budget.path) : [];
    const budgetFailures = evaluateAbsoluteBudget(budget, size, sources);

    failures.push(...budgetFailures);
    report.push({
      ...size,
      kind: "absolute",
      maxBytes: budget.maxBytes ?? null,
      maxGzipBytes: budget.maxGzipBytes ?? null,
      ok: budgetFailures.length === 0
    });
    lines.push(
      `${budgetFailures.length === 0 ? "ok  " : "FAIL"} ${size.path}: raw=${size.bytes}/${budget.maxBytes ?? "-"} gzip=${size.gzipBytes}/${budget.maxGzipBytes ?? "-"}`
    );
  }

  for (const path of config.delta.entries) {
    const size = await measure(path);
    const base = baseline?.get(path);
    const result = baseline ? evaluateDelta(config.delta, size, base, notes) : null;

    if (result?.status === "failed" && result.message) {
      failures.push(result.message);
    }

    report.push({
      ...size,
      kind: "delta",
      baseBytes: base?.bytes ?? null,
      baseGzipBytes: base?.gzipBytes ?? null,
      status: result?.status ?? "unchecked",
      ok: result?.status !== "failed"
    });
    lines.push(formatDeltaLine(size, base, result));
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2),
    "utf8"
  );

  for (const line of lines) {
    console.log(line);
  }

  if (!baseline) {
    console.log("Delta check skipped: no --baseline report given (absolute budgets still apply).");
  }

  console.log("Bundle size report:", reportPath);
  await writeStepSummary(report, Boolean(baseline));

  if (failures.length > 0) {
    throw new Error(`Bundle size gate failed:\n- ${failures.join("\n- ")}`);
  }
}

/** @param {string} path */
async function measure(path) {
  const source = await readFile(resolve(root, path)).catch(() => {
    throw new Error(`${path}: bundle not found — run \`pnpm build\` first`);
  });

  return { path, bytes: source.byteLength, gzipBytes: gzipSync(source).byteLength };
}

/**
 * @param {string} path
 * @returns {Promise<string[] | null>}
 */
async function readSourcemapSources(path) {
  try {
    const map = JSON.parse(await readFile(resolve(root, `${path}.map`), "utf8"));

    return Array.isArray(map.sources) ? map.sources.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ path: string, bytes: number, gzipBytes: number }} size
 * @param {{ bytes: number, gzipBytes: number } | undefined} base
 * @param {{ status: string, reason: string | null } | null} result
 */
function formatDeltaLine(size, base, result) {
  const current = `${size.path}: raw=${size.bytes} gzip=${size.gzipBytes}`;

  if (!result) {
    return `    ${current}`;
  }

  if (!base) {
    return `new  ${current} (not in baseline)`;
  }

  const delta = `${formatSigned(size.bytes - base.bytes)} B ${formatPercent(size.bytes - base.bytes, base.bytes)}`;
  const label = { ok: "ok  ", explained: "note", failed: "FAIL" }[result.status] ?? "    ";

  return `${label} ${current} (${delta} vs base)${result.status === "explained" ? ` explained: ${result.reason}` : ""}`;
}

/** @param {number} value */
function formatSigned(value) {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * Appends a Markdown table to the GitHub Actions job summary when running in CI.
 * @param {Array<Record<string, unknown>>} report
 * @param {boolean} hasBaseline
 */
async function writeStepSummary(report, hasBaseline) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryPath) {
    return;
  }

  const rows = report.map((row) => {
    const limit =
      row.kind === "absolute"
        ? `≤ ${row.maxBytes ?? "-"} / ${row.maxGzipBytes ?? "-"}`
        : row.baseBytes === null || row.baseBytes === undefined
          ? hasBaseline
            ? "new"
            : "no baseline"
          : `base ${row.baseBytes} (${formatPercent(Number(row.bytes) - Number(row.baseBytes), Number(row.baseBytes))})`;

    return `| ${row.ok ? "✅" : "❌"} | \`${row.path}\` | ${row.kind} | ${row.bytes} | ${row.gzipBytes} | ${limit} |`;
  });
  const table = [
    "### Bundle size",
    "",
    "| | Bundle | Check | Raw B | Gzip B | Budget / base |",
    "|---|---|---|---|---|---|",
    ...rows,
    ""
  ].join("\n");

  await appendFile(summaryPath, `${table}\n`, "utf8");
}
