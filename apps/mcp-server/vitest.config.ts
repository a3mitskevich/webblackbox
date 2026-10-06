import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@webblackbox/player-sdk": fileURLToPath(
        new URL("../../packages/player-sdk/src/index.ts", import.meta.url)
      ),
      "@webblackbox/protocol/schemas": fileURLToPath(
        new URL("../../packages/protocol/src/schemas-entry.ts", import.meta.url)
      ),
      "@webblackbox/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url)
      )
    }
  }
});
