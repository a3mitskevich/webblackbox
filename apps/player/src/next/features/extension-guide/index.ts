import type { PlayerFeature } from "../types.js";
import { extensionGuideMessages } from "./messages.js";

/**
 * Extension guide (task 50): the bundled extension download and the install / connect / record
 * how-to, as a dialog. The header menu and the empty state open it with
 * `openExtensionGuide(store)` (`slice.ts`); the app root mounts `ExtensionGuideDialog`, which
 * loads the dialog's chunk on first use. No rail tab; works without an archive.
 */
export const extensionGuideFeature: PlayerFeature = {
  id: "extension-guide",
  messages: extensionGuideMessages
};

export { closeExtensionGuide, extensionGuideSlice, openExtensionGuide } from "./slice.js";
export { ExtensionGuideDialog } from "./extension-guide-entry.js";
export { extensionGuideMessages } from "./messages.js";
export type { ExtensionGuideMessageKey, ExtensionGuideTranslate } from "./messages.js";
