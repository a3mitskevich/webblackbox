import type { PlayerFeature } from "../types.js";
import { shareMessages } from "./messages.js";

/**
 * Share links (R4): the header's Share button (`share-button.tsx`, rendered by the header) uploads
 * the open recording or opens a shared one; no rail tab.
 */
export const shareFeature: PlayerFeature = {
  id: "share",
  messages: shareMessages
};
