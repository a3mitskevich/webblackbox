import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

import { startPageDomRecorder } from "../src/injected-dom/index.js";

// The rrweb DOM recorder the service worker runs with `scripting.executeScript({ world: "MAIN",
// files })` in the top frame of a recorded tab, next to the page hooks.
export default defineUnlistedScript(() => startPageDomRecorder());
