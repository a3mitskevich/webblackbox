import { configDefaults, defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    environment: "node",
    // Load tests run in their own project: see vitest.perf.config.ts.
    exclude: [...configDefaults.exclude, "src/**/*.perf.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-support/**"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 65
      }
    }
  }
});
