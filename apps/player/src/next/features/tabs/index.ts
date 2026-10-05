import type { PlayerLocale } from "../../../lib/i18n.js";
import { placeholderPanel } from "../placeholder.js";
import type { PlayerFeature } from "../types.js";
import { tabsMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => tabsMessages.translate(locale, "tabLabel");

/** Tabs (R4): the "tabs" rail tab; a placeholder until R4 lands. */
export const tabsFeature: PlayerFeature = {
  id: "tabs",
  messages: tabsMessages,
  railTabs: [
    {
      id: "tabs",
      label,
      count: (archive) => archive.view.meta.otherTabs,
      Panel: placeholderPanel("tabs", label)
    }
  ]
};
