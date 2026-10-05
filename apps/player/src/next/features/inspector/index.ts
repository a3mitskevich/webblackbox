import type { PlayerFeature } from "../types.js";

/**
 * Event inspector (R5). Registers nothing yet; R5 adds its UI here (target + frame on the video, what it caused, raw event), its
 * strings in `locales/` (see src/next/README.md) and its e2e scenarios in `inspector.e2e.mjs`.
 */
export const inspectorFeature: PlayerFeature = {
  id: "inspector"
};
