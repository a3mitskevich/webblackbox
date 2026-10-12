import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

// The content script is not declared in the manifest: the service worker registers `content.js`
// or injects it on Start (see `src/sw/content-injection.ts`). An unlisted script is bundled as an
// anonymous IIFE, so the file declares nothing in the isolated world it runs in.
import "../src/content/index.js";

export default defineUnlistedScript(() => {});
