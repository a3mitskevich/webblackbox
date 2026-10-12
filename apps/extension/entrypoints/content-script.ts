import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

import { startContentScript } from "../src/content/index.js";

// Not declared in the manifest: the service worker registers it or injects it on Start
// (see `src/sw/content-injection.ts`).
export default defineUnlistedScript(() => startContentScript());
