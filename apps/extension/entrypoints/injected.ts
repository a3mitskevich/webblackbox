import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

// Page hooks the service worker runs with `scripting.executeScript({ world: "MAIN", files })`.
// The anonymous IIFE keeps every binding out of the page's own globals (#48).
import "../src/injected/index.js";

export default defineUnlistedScript(() => {});
