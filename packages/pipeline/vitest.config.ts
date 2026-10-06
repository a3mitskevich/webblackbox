import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 65,
        // Privacy-critical code: keep a stricter per-file floor than the package default.
        "src/privacy.ts": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 75
        }
      }
    }
  }
});
