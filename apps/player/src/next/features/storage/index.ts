import type { PlayerLocale } from "../../../lib/i18n.js";
import { placeholderPanel } from "../placeholder.js";
import type { PlayerFeature } from "../types.js";
import { storageMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => storageMessages.translate(locale, "tabLabel");

/** Storage (R4): the "storage" rail tab; a placeholder until R4 lands. */
export const storageFeature: PlayerFeature = {
  id: "storage",
  messages: storageMessages,
  railTabs: [
    {
      id: "storage",
      label,
      count: (archive) => archive.model.storage.length,
      Panel: placeholderPanel("storage", label)
    }
  ]
};
