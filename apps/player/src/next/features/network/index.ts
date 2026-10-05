import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { networkMessages } from "./messages.js";
import { getNetworkModel } from "./rows.js";

const networkLabel = (locale: PlayerLocale): string =>
  networkMessages.translate(locale, "networkTab");
const realtimeLabel = (locale: PlayerLocale): string =>
  networkMessages.translate(locale, "realtimeTab");

// The panels, their viewers and Shiki load as their own chunks the first time a tab opens.
const NetworkPanel = lazy(() => import("./network-panel.js"));
const RealtimePanel = lazy(() => import("./realtime-panel.js"));

/** Network (R3): the "network" table with request / socket details and the "realtime" tab. */
export const networkFeature: PlayerFeature = {
  id: "network",
  messages: networkMessages,
  railTabs: [
    {
      id: "network",
      label: networkLabel,
      count: (archive) => getNetworkModel(archive).rows.length,
      Panel: NetworkPanel
    },
    {
      id: "realtime",
      label: realtimeLabel,
      count: (archive) =>
        getNetworkModel(archive).streams.reduce((sum, stream) => sum + stream.messages.length, 0),
      Panel: RealtimePanel
    }
  ]
};
