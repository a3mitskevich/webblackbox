import { defineConfig } from "vite";

/**
 * The DOM replay frame, built after the Player into build/replay/ next to
 * `public/replay/index.html`: one self-contained classic script (rrweb's replayer and the frame
 * glue) and one stylesheet, so the frame's CSP can stay `script-src 'self'` with no module graph.
 */
export default defineConfig({
  // The Player build already copied `public/` (with replay/index.html) into build/.
  publicDir: false,
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
