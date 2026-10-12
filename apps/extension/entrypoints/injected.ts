import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

import { startInjectedHooks } from "../src/injected/index.js";

// Page hooks the service worker runs with `scripting.executeScript({ world: "MAIN", files })`.
export default defineUnlistedScript(() => startInjectedHooks());
