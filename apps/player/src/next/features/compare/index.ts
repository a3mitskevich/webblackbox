import type { PlayerFeature } from "../types.js";

/**
 * Compare + regressions (R4). Registers nothing yet; R4 adds its UI here (lazy-load the panel (`React.lazy`) — it pulls jsdiff/microdiff), its
 * strings in `locales/` (see src/next/README.md) and its e2e scenarios in `compare.e2e.mjs`.
 */
export const compareFeature: PlayerFeature = {
  id: "compare"
};
