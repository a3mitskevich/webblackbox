import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { devCsp, readCsp, withCsp } from "./scripts/lib/csp-policy.mjs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const playerVersion =
  typeof packageJson.version === "string" && packageJson.version.length > 0
    ? packageJson.version
    : "0.0.0";

/**
 * Dev server only: React refresh injects an inline preamble script, HMR talks over ws: and Vite
 * injects CSS modules as <style> elements, which the production policy (script-src 'self',
 * style-src 'self') forbids. Production builds keep index.html as is.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: "webblackbox-player:dev-csp",
    apply: "serve",
    transformIndexHtml: (html) => withCsp(html, devCsp(readCsp(html)))
  };
}

export default defineConfig({
  // Relative URLs: the build is served from a GitHub Pages sub-path and from /player/ in e2e.
  base: "./",
  plugins: [react(), devContentSecurityPolicy()],
  // Bundle `@webblackbox/*` from their sources via tsconfig `paths` (as tsup did): the Pages
  // release job and `pnpm player` build only this package, without the dependencies' `dist/`.
  resolve: {
    tsconfigPaths: true
  },
  define: {
    __PLAYER_VERSION__: JSON.stringify(playerVersion)
  },
  server: {
    port: 4177
  },
  preview: {
    port: 4177
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    // `font-src`/`img-src` fall back to 'self': never inline fonts or icons as data: URIs.
    assetsInlineLimit: 0,
    // Every supported browser has <link rel="modulepreload">; skip the polyfill.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // player-sdk imports these only on Node (behind a `process.versions.node` check); the
      // browser never evaluates the dynamic import, so leave it as is instead of a stub chunk.
      external: ["node:zlib", "node:crypto"],
      output: {
        // React and the archive SDK change rarely: name those chunks so they cache across
        // releases and read clearly in the bundle report. Everything else splits automatically.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 20
            },
            {
              // Zod and `src/zod-config.ts` share a chunk on purpose: `z.config({ jitless: true })`
              // must run before any protocol schema is built, or Zod probes `Function("")` and
              // the CSP reports an eval. Every chunk that builds schemas imports this one, so
              // the config call always runs first, wherever the bundler places the rest.
              name: "zod",
              test: /[\\/](node_modules[\\/]zod[\\/]|src[\\/]zod-config\.ts$)/,
              priority: 30
            },
            {
              name: "sdk",
              test: /[\\/](packages[\\/](player-sdk|protocol)|node_modules[\\/](jszip|@jridgewell)[\\/])/,
              priority: 10
            }
          ]
        },
        // The entry keeps its stable name: Pages, the extension e2e and the player e2e load
        // `main.js`; lazily loaded chunks, CSS and fonts are content-hashed under assets/.
        entryFileNames: "main.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
