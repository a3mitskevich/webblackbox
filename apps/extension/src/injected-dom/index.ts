import { installPageDomRecorder } from "webblackbox/rrweb-page-recorder";

// rrweb in the page's MAIN world: from the content script's isolated world it misses the CSS rules
// the page writes through the CSSOM (CSS-in-JS). Injected on Start into the top frame of a
// recorded tab; it records only between the content script's start and stop commands.
installPageDomRecorder();
