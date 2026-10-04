import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@webblackbox/pipeline": resolve(root, "../pipeline/src/index.ts"),
      // Before the package alias: string aliases also match `@webblackbox/protocol/…` prefixes.
      "@webblackbox/protocol/secret-detection": resolve(
        root,
        "../protocol/src/secret-detection.ts"
      ),
      "@webblackbox/protocol": resolve(root, "../protocol/src/index.ts"),
      "@webblackbox/recorder": resolve(root, "../recorder/src/index.ts")
    }
  },
  test: {
    environment: "node"
  }
});
