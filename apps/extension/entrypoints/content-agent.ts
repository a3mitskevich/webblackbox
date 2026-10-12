import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

// Placeholder: WXT bundles unlisted scripts as IIFE only, while `content-agent.js` is an ES module
// whose exports `content.js` imports at runtime. `wxt.config.ts` builds this entry from
// `src/content/content-agent.ts` in ES format instead of this file.
export default defineUnlistedScript(() => {});
