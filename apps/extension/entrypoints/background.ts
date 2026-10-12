import { defineBackground } from "wxt/utils/define-background";

import { startServiceWorker } from "../src/sw/index.js";

export default defineBackground({
  type: "module",
  main: () => startServiceWorker()
});
