import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@webblackbox/pipeline": resolve(root, "../pipeline/src/index.ts"),
      "@webblackbox/protocol": resolve(root, "../protocol/src/index.ts"),
      "@webblackbox/recorder": resolve(root, "../recorder/src/index.ts")
    }
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/types.ts"],
      // This code runs on customer pages. Floors sit a few points below the measured
      // baseline so coverage cannot silently regress; raise them as tests are added.
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 75,
        branches: 55,
        "src/injected-hooks.ts": {
          lines: 50,
          statements: 50,
          functions: 55,
          branches: 40
        }
      }
    }
  }
});
