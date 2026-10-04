import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      { find: "@webblackbox/pipeline", replacement: resolve(root, "../pipeline/src/index.ts") },
      { find: "@webblackbox/protocol", replacement: resolve(root, "../protocol/src/index.ts") },
      { find: "@webblackbox/recorder", replacement: resolve(root, "../recorder/src/index.ts") }
    ]
  },
  test: {
    environment: "node"
  }
});
