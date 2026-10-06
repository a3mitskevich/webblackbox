import { defineConfig } from "tsup";

// One output file per source module (no bundling), so `"sideEffects": false` lets consumers'
// bundlers drop modules they do not use — above all `schemas.js` and with it zod.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm"],
  bundle: false,
  dts: true,
  clean: true
});
