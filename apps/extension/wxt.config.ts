import type { PluginOption } from "vite";
import { defineConfig } from "wxt";

import {
  assertExtensionBuild,
  createManifestFields,
  profileForMode
} from "./scripts/lib/extension-build.mjs";
import { mergedLocalesPlugin } from "./scripts/lib/locale-fragments.mjs";
import { createManagedStorageSchema, MANAGED_SCHEMA_FILE } from "./scripts/lib/managed-schema.mjs";

/**
 * Auto-imports stay off. WXT 0.21.4 keeps unimport's Vite transform even with `imports: false`,
 * and unimport's regex detection takes a parameter named `storage` for a free variable: it adds
 * `import { storage } from "wxt/utils/storage"` to our modules (bundling @wxt-dev/storage into the
 * service worker and pages) and to the workspace packages' `dist/` (which fails the build).
 */
function withoutAutoImports(plugins: PluginOption[] = []): PluginOption[] {
  return plugins
    .filter((plugin) => !(plugin && "name" in plugin && plugin.name === "unimport"))
    .map((plugin) => (Array.isArray(plugin) ? withoutAutoImports(plugin) : plugin));
}

// WXT defaults throughout: `entrypoints/` at the project root, output in `.output/chrome-mv3/`
// (`.output/chrome-mv3-store-safe/` for `--mode store-safe`), `wxt zip` for packaging. The
// deviations below each keep recording from suffering; the PR that introduced WXT lists why.
export default defineConfig({
  imports: false,
  manifest: ({ mode, command }) => createManifestFields({ profile: profileForMode(mode), command }),
  vite: () => ({
    // The UI dictionaries merged from per-feature fragments: the pages switch language at runtime,
    // which `chrome.i18n` (and WXT's i18n module on top of it) cannot.
    plugins: [mergedLocalesPlugin()],
    // `pnpm bundle:size` reads the source maps to keep zod and other heavy sources out of the
    // scripts every recorded frame parses.
    build: { sourcemap: true }
  }),
  zip: {
    // Source maps are for the size gate, not for testers installing the extension.
    exclude: ["**/*.map"]
  },
  hooks: {
    "vite:build:extendConfig": (entrypoints, config) => {
      config.plugins = withoutAutoImports(config.plugins);
      const output = config.build?.rollupOptions?.output;

      // Scripts injected into pages (WXT's anonymous IIFE) run in strict mode: an assignment to an
      // undeclared name throws instead of creating a global of the page (#48, #50).
      if (entrypoints.every((entry) => entry.type === "unlisted-script") && output) {
        for (const options of Array.isArray(output) ? output : [output]) {
          options.intro = '"use strict";';
        }
      }
    },
    "build:publicAssets": (_wxt, files) => {
      files.push({
        relativeDest: MANAGED_SCHEMA_FILE,
        contents: `${JSON.stringify(createManagedStorageSchema(), null, 2)}\n`
      });
    },
    "build:done": async (wxt) => {
      if (wxt.config.command === "build") {
        await assertExtensionBuild(wxt.config.outDir, { profile: profileForMode(wxt.config.mode) });
      }
    }
  }
});
