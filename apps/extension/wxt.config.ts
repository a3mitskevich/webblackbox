import { resolve } from "node:path";

import type { PluginOption } from "vite";
import { defineConfig, type EntrypointGroup } from "wxt";

import {
  assertExtensionBuild,
  createManifestFields,
  normalizeWxtManifest,
  readBuildTarget
} from "./scripts/lib/extension-build.mjs";
import { mergedLocalesPlugin } from "./scripts/lib/locale-fragments.mjs";
import { createManagedStorageSchema, MANAGED_SCHEMA_FILE } from "./scripts/lib/managed-schema.mjs";

/** `content-agent.js` stays an ES module: `content.js` imports its exports at runtime. */
const CONTENT_AGENT_SOURCE = resolve(import.meta.dirname, "src/content/content-agent.ts");

/**
 * Output names WXT cannot derive from the entrypoint name: WXT names the service worker
 * `background.js`, and an entrypoint named `content` is always a manifest content script.
 */
const ENTRY_FILE_NAMES: Readonly<Record<string, string>> = {
  background: "sw.js",
  "content-script": "content.js"
};

/**
 * WXT adds unimport's Vite plugin even with `imports: false`, and unimport still guesses imports
 * for free identifiers: it added `wxt/utils/storage` to the pipeline bundle for a `storage`
 * constructor parameter. The sources import everything explicitly.
 */
function withoutAutoImports(plugins: PluginOption[] = []): PluginOption[] {
  return plugins
    .filter((plugin) => !(plugin && "name" in plugin && plugin.name === "unimport"))
    .map((plugin) => (Array.isArray(plugin) ? withoutAutoImports(plugin) : plugin));
}

// `scripts/build-extension.mjs` passes the profile and release flag through the environment, so a
// plain `wxt build` is the default development build.
const target = readBuildTarget(process.env);

export default defineConfig({
  entrypointsDir: "entrypoints",
  // Same unpacked layout as before WXT: e2e, bundle budgets, the Player bundler and packaging
  // read `build/` directly.
  outDir: "build",
  outDirTemplate: "",
  // Explicit imports only: WXT would otherwise scan the sources for auto-imports.
  imports: false,
  webExt: { disabled: true },
  manifest: createManifestFields(target),
  vite: () => ({
    plugins: [mergedLocalesPlugin()],
    build: {
      target: "es2022",
      // `injected.js` and `content-agent.js` are parsed on every navigation of every recorded frame.
      minify: true,
      sourcemap: true,
      modulePreload: false
    }
  }),
  hooks: {
    // WXT builds the service worker and the four pages in one Vite build with shared `chunks/`.
    // One build per entry keeps every context in its own self-contained file, as before.
    "entrypoints:grouped": (_wxt, groups) => {
      const singleEntryGroups = groups.flatMap((group): EntrypointGroup[] =>
        Array.isArray(group) ? group.map((entry) => [entry]) : [group]
      );
      groups.splice(0, groups.length, ...singleEntryGroups);
    },
    "vite:build:extendConfig": (entrypoints, config) => {
      config.plugins = withoutAutoImports(config.plugins);

      const [entrypoint] = entrypoints;

      if (entrypoints.length !== 1 || !entrypoint) {
        return;
      }

      const output = config.build?.rollupOptions?.output;

      if (!output || Array.isArray(output)) {
        throw new Error(`Unexpected WXT output options for ${entrypoint.name}.`);
      }

      if (entrypoint.name === "content-agent") {
        config.build = {
          ...config.build,
          lib: { ...config.build?.lib, entry: CONTENT_AGENT_SOURCE, formats: ["es"] }
        };
        // Vite's library mode keeps the whitespace of ES bundles; this one is parsed per frame.
        output.minify = true;
        return;
      }

      const fileName = ENTRY_FILE_NAMES[entrypoint.name];

      if (fileName) {
        output.entryFileNames = fileName;
      }

      if (entrypoint.type === "background" || entrypoint.inputPath.endsWith(".html")) {
        output.entryFileNames = fileName ?? "[name].js";
        output.inlineDynamicImports = true;
      }
    },
    "build:publicAssets": (_wxt, files) => {
      files.push({
        relativeDest: MANAGED_SCHEMA_FILE,
        contents: `${JSON.stringify(createManagedStorageSchema(), null, 2)}\n`
      });
    },
    "build:manifestGenerated": (_wxt, manifest) => {
      normalizeWxtManifest(manifest, target);
    },
    "build:done": async (wxt) => {
      if (wxt.config.command === "build") {
        await assertExtensionBuild(wxt.config.outDir, target);
      }
    }
  }
});
