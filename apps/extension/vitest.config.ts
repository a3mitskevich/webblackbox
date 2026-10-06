import { defineConfig } from "vitest/config";

import { workspaceSourceAliases } from "../../config/workspace-sources.mjs";

export default defineConfig({
  resolve: {
    alias: workspaceSourceAliases()
  }
});
