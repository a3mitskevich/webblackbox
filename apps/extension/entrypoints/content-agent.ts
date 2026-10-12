import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

import { startContentAgent } from "../src/content/content-agent.js";

// Injected by the service worker into the isolated world of a frame that records, on that frame's
// request (`content.agent-request`): frames that never record never parse it.
export default defineUnlistedScript(() => startContentAgent());
