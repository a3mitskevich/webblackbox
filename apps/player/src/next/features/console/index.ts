import type { PlayerLocale } from "../../../lib/i18n.js";
import { placeholderPanel } from "../placeholder.js";
import type { PlayerFeature } from "../types.js";
import { consoleMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => consoleMessages.translate(locale, "tabLabel");

/** Console (R4): the "console" rail tab; a placeholder until R4 lands. */
export const consoleFeature: PlayerFeature = {
  id: "console",
  messages: consoleMessages,
  railTabs: [
    {
      id: "console",
      label,
      count: (archive) => archive.model.consoleSignals.length,
      isAlert: (count) => count > 0,
      Panel: placeholderPanel("console", label)
    }
  ]
};
