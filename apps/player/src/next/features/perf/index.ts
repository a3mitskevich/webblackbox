import type { PlayerLocale } from "../../../lib/i18n.js";
import { placeholderPanel } from "../placeholder.js";
import type { PlayerFeature } from "../types.js";
import { perfMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => perfMessages.translate(locale, "tabLabel");

/** Perf (R4): the "perf" rail tab; a placeholder until R4 lands. */
export const perfFeature: PlayerFeature = {
  id: "perf",
  messages: perfMessages,
  railTabs: [
    {
      id: "perf",
      label,
      count: (archive) => archive.model.perf.length,
      Panel: placeholderPanel("perf", label)
    }
  ]
};
