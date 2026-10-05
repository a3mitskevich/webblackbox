import { defineConfig } from "vitest/config";

// The unit tests run on the workspace vitest (4.x, built on Vite 7). This file keeps vitest from
// loading `vite.config.ts`, whose Vite 8 plugins it cannot run; tests need no build plugins.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"]
  }
});
