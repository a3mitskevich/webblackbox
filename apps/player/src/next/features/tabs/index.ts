import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { tabsMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => tabsMessages.translate(locale, "tabLabel");

const TabsPanel = lazy(() => import("./tabs-panel.js"));

/** Tabs (R4): the other tabs of the recorded site, open at the playhead and their changes. */
export const tabsFeature: PlayerFeature = {
  id: "tabs",
  messages: tabsMessages,
  railTabs: [
    {
      id: "tabs",
      label,
      count: (archive) => archive.view.meta.otherTabs,
      Panel: TabsPanel
    }
  ]
};
