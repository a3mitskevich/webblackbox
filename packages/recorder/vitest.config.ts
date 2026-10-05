import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Subpath exports first: a string alias would also match their `@webblackbox/protocol/` prefix.
    alias: [
      {
        find: /^@webblackbox\/protocol\/(.+)$/,
        replacement: resolve(root, "../protocol/src/$1.ts")
      },
      { find: "@webblackbox/protocol", replacement: resolve(root, "../protocol/src/index.ts") }
    ]
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/types.ts"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 65,
        // Privacy-critical code: keep a stricter per-file floor than the package default.
        "src/redaction.ts": {
          lines: 85,
          statements: 85,
          functions: 85,
          branches: 75
        }
      }
    }
  }
});
