import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

// Load tests (`*.perf.test.ts`): excluded from `pnpm test`, run by `test:pressure` with a budget
// that only bounds a hang. They assert sizes and counts, never elapsed time.
const PERF_TEST_TIMEOUT_MS = 120_000;

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    environment: "node",
    include: ["src/**/*.perf.test.ts"],
    testTimeout: PERF_TEST_TIMEOUT_MS
  }
});
