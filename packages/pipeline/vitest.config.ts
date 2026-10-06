import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

// Exports are always encrypted (#10), so most tests derive PBKDF2 keys at the archive's fixed
// iteration count, some several times. With every package's tests running at once on a CI runner
// that alone can pass vitest's 5 s default. The bound below only catches a hang; no assertion
// depends on it.
const ENCRYPTED_EXPORT_TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  },
  test: {
    environment: "node",
    testTimeout: ENCRYPTED_EXPORT_TEST_TIMEOUT_MS,
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
