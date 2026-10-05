import type { PlayerFeature } from "../types.js";

/**
 * Share links, privacy preflight and API keys (R4). Registers nothing yet; R4 adds its UI here (dialogs on Base UI), its
 * strings in `locales/` (see src/next/README.md) and its e2e scenarios in `share.e2e.mjs`.
 */
export const shareFeature: PlayerFeature = {
  id: "share"
};
