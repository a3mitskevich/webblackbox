import { defineConfig } from "vite";

/**
 * The sandboxed DOM replay frame (spike, task 56), built after the Player into build/replay/
 * next to `public/replay/index.html`. A classic IIFE script on purpose: the frame has an opaque
 * origin (`sandbox="allow-scripts"`), and a module script would be a CORS request with
 * `Origin: null` that the static Player host does not allow.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true
  },
  build: {
    outDir: "build/replay",
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    assetsInlineLimit: 0,
    lib: {
      entry: "replay-frame/main.ts",
      formats: ["iife"],
      name: "WebBlackboxDomReplay",
      fileName: () => "replay.js",
      cssFileName: "replay"
    }
  }
});
