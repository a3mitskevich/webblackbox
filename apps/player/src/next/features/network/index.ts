import type { PlayerLocale } from "../../../lib/i18n.js";
import { placeholderPanel } from "../placeholder.js";
import type { PlayerFeature } from "../types.js";
import { networkMessages } from "./messages.js";

const networkLabel = (locale: PlayerLocale): string =>
  networkMessages.translate(locale, "networkTab");
const realtimeLabel = (locale: PlayerLocale): string =>
  networkMessages.translate(locale, "realtimeTab");

/** Network (R3): the "network" and "realtime" (WebSocket / SSE) rail tabs; placeholders until R3. */
export const networkFeature: PlayerFeature = {
  id: "network",
  messages: networkMessages,
  railTabs: [
    {
      id: "network",
      label: networkLabel,
      count: (archive) => archive.model.waterfall.length,
      Panel: placeholderPanel("network", networkLabel)
    },
    {
      id: "realtime",
      label: realtimeLabel,
      count: (archive) => archive.model.realtime.length,
      Panel: placeholderPanel("realtime", realtimeLabel)
    }
  ]
};
