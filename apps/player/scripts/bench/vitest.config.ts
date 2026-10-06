import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../../../config/workspace-sources.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The jsdom render pass of the Player bench (`render-ticks.bench.tsx`), run by
 * `scripts/benchmark.ts`. Kept out of `pnpm test`: it opens a ten-minute archive.
 */
export default defineConfig({
  root,
  // Sibling packages from `src/`, like the unit tests: `bench:ci` runs before `pnpm build`.
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    include: ["scripts/bench/*.bench.tsx"],
    setupFiles: ["src/test-setup.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000
  }
});
