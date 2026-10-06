import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";
import { writeMergedLocales } from "./scripts/lib/locale-fragments.mjs";

// The page tests render the whole Options, popup and Sessions pages in jsdom; a file's first
// render takes ~0.7 s on an idle machine and went past vitest's 5 s default on CI runners, where
// every package's tests run at once. The bound below only catches a hang; no assertion depends on
// it.
const PAGE_TEST_TIMEOUT_MS = 30_000;

// `src/shared/i18n.ts` imports the dictionaries merged from the per-feature fragments.
writeMergedLocales();

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    testTimeout: PAGE_TEST_TIMEOUT_MS
  }
});
