import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

// The unit tests run on the workspace vitest (4.x, built on Vite 7). This file keeps vitest from
// loading `vite.config.ts`, whose Vite 8 plugins it cannot run; tests need no build plugins.
export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    setupFiles: ["src/test-setup.ts"]
  }
});
