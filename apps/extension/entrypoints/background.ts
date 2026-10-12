import { defineBackground } from "wxt/utils/define-background";

// The service worker starts at the top level of `src/sw/index.ts`, as before WXT. WXT drops
// side-effect imports when it imports this file in Node to read the options below, so none of
// that runtime code runs at build time.
import "../src/sw/index.js";

export default defineBackground({
  type: "module",
  main() {}
});
