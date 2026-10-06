import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

// index.test.ts starts a real share-server process per test (`tsx src/index.ts`). Startup alone
// takes ~1 s idle and several seconds on a loaded runner, so vitest's 5 s default measures the
// machine, not the server. The budget below only bounds a hung server; no assertion depends on it.
const PROCESS_TEST_TIMEOUT_MS = 60_000;

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    testTimeout: PROCESS_TEST_TIMEOUT_MS,
    hookTimeout: PROCESS_TEST_TIMEOUT_MS
  }
});
