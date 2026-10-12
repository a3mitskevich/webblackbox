#!/usr/bin/env node
// Serves the bug zoo for manual exploration: `pnpm --filter @webblackbox/evals site`.
// WB_EVAL_SITE_PORT fixes the port (default: a free one). Ctrl+C stops it.

import { SCENARIOS } from "./scenarios/index.js";
import { startBugZooSite } from "./site/server.js";

const port = Number(process.env.WB_EVAL_SITE_PORT ?? 0);
const site = await startBugZooSite(SCENARIOS, { port: Number.isInteger(port) ? port : 0 });

console.log(`Bug zoo: ${site.origin}/`);

for (const scenario of SCENARIOS) {
  const [page] = Object.keys(scenario.pages);
  console.log(`  ${scenario.caseId} ${scenario.id}: ${site.origin}${page ?? "/"}`);
}

const stop = (): void => {
  void site.close().then(() => process.exit(0));
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
