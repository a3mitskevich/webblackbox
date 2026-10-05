import type { PlayerLocale } from "../../../lib/i18n.js";
import { selectActivityEvents } from "../../controller.js";
import type { PlayerFeature } from "../types.js";
import { ActivityPanel } from "./activity-panel.js";
import { feedMessages } from "./messages.js";

/** Activity feed and problems strip (R2). Today: R1's Activity list with the details pane. */
export const feedFeature: PlayerFeature = {
  id: "feed",
  messages: feedMessages,
  railTabs: [
    {
      id: "activity",
      label: (locale: PlayerLocale) => feedMessages.translate(locale, "tabLabel"),
      count: (archive, query) => selectActivityEvents(archive, query).length,
      Panel: ActivityPanel
    }
  ]
};
