#!/usr/bin/env node
// Records the WebBlackbox usage videos on the Windows desktop (from WSL). See README.md.
//
//   node apps/extension/scripts/demo-video/run.mjs --list
//   node apps/extension/scripts/demo-video/run.mjs install              one take, recorded
//   node apps/extension/scripts/demo-video/run.mjs all                  every scenario in order
//   node apps/extension/scripts/demo-video/run.mjs install --rehearsal  same steps, no recording
//   node apps/extension/scripts/demo-video/run.mjs all --dry-run        captions only, no desktop
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAss, cuesFromMarks, dryRunMarks, LANGS, validateScenario } from "./lib/captions.mjs";
import { SCENARIOS, findScenario } from "./scenarios/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY_RUN_DIR = resolve(HERE, "..", "..", "demo-video-output", "dry-run");
const DRY_RUN_FRAME = Object.freeze({ width: 1600, height: 1000, barHeight: 110 });

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const langFlag = argv.find((arg) => arg.startsWith("--lang="));
  return {
    target: positional[0] ?? "",
    list: flags.has("--list"),
    dryRun: flags.has("--dry-run"),
    rehearsal: flags.has("--rehearsal"),
    keepRaw: flags.has("--keep-raw"),
    lang: langFlag ? langFlag.slice("--lang=".length) : LANGS[0]
  };
}

function selectScenarios(target) {
  if (target === "all") return [...SCENARIOS];
  const scenario = findScenario(target);
  if (!scenario) {
    throw new Error(
      `unknown scenario "${target}"; known: ${SCENARIOS.map((s) => s.id).join(", ")}`
    );
  }
  return [scenario];
}

function dryRun(scenarios, lang) {
  mkdirSync(DRY_RUN_DIR, { recursive: true });
  for (const scenario of scenarios) {
    const { marks, endMs } = dryRunMarks(scenario.steps, lang);
    const cues = cuesFromMarks(marks, endMs);
    const file = join(DRY_RUN_DIR, `${scenario.id}.${lang}.ass`);
    writeFileSync(
      file,
      buildAss({
        cues,
        width: DRY_RUN_FRAME.width,
        videoHeight: DRY_RUN_FRAME.height,
        barHeight: DRY_RUN_FRAME.barHeight,
        title: scenario.title[lang]
      })
    );
    console.log(
      `${scenario.id}: ${cues.length} captions, ~${Math.round(endMs / 1000)} s -> ${file}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list || !args.target) {
    for (const scenario of SCENARIOS) console.log(`${scenario.id}\t${scenario.title.ru}`);
    if (!args.list)
      console.log("\nusage: run.mjs <scenario|all> [--rehearsal|--dry-run|--keep-raw]");
    return;
  }
  if (!LANGS.includes(args.lang)) throw new Error(`no captions for language "${args.lang}"`);
  const scenarios = selectScenarios(args.target);
  const problems = scenarios.flatMap(validateScenario);
  if (problems.length > 0) throw new Error(`invalid scenarios:\n${problems.join("\n")}`);
  if (args.dryRun) {
    dryRun(scenarios, args.lang);
    return;
  }
  // Desktop modules load only for real takes: a dry run works anywhere, including CI.
  const { runTake } = await import("./lib/take.mjs");
  const log = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  for (const scenario of scenarios) {
    const result = await runTake({
      scenario,
      lang: args.lang,
      log,
      keepRaw: args.keepRaw,
      rehearsal: args.rehearsal
    });
    if (result) log(`done: ${result.reviewWin} (${Math.round(result.durationMs / 1000)} s)`);
    else log(`rehearsal of ${scenario.id} finished`);
  }
}

main().catch((error) => {
  console.error(error.name === "AbortedError" ? `\n${error.message}` : error);
  process.exitCode = 1;
});
