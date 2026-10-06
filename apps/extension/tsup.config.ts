import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

import { contentScriptScopePlugin } from "./scripts/lib/content-script-scope.mjs";
import { mergedLocalesPlugin } from "./scripts/lib/locale-fragments.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const extensionNodeModulesDir = resolve(appRoot, "node_modules");
const workspaceNodeModulesDir = resolve(appRoot, "..", "..", "node_modules");

export default defineConfig({
  entry: {
    sw: "src/sw/index.ts",
    content: "src/content/index.ts",
    "content-agent": "src/content/content-agent.ts",
    offscreen: "src/offscreen/index.ts",
    popup: "src/popup/index.ts",
    options: "src/options/index.ts",
    sessions: "src/sessions/index.ts",
    injected: "src/injected/index.ts"
  },
  format: ["esm"],
  target: "es2022",
  platform: "browser",
  bundle: true,
  skipNodeModulesBundle: false,
  noExternal: [/.*/],
  // `injected.js` and `content-agent.js` are parsed on every navigation of every recorded frame.
  minify: true,
  sourcemap: true,
  outDir: "build",
  clean: true,
  splitting: false,
  dts: false,
  plugins: [mergedLocalesPlugin(), contentScriptScopePlugin()],
  esbuildOptions(options) {
    options.external = [];
    options.nodePaths = [extensionNodeModulesDir, workspaceNodeModulesDir];
  }
});
