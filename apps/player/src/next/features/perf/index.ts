import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { perfMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => perfMessages.translate(locale, "tabLabel");

/** Its own chunk, with uPlot and its stylesheet. */
const PerfPanel = lazy(() => import("./perf-panel.js"));

/** Perf (R4): web vitals, canvas series with the playhead, and recorded artifacts. */
export const perfFeature: PlayerFeature = {
  id: "perf",
  messages: perfMessages,
  railTabs: [
    {
      id: "perf",
      label,
      count: (archive) => archive.model.perf.length,
      Panel: PerfPanel
    }
  ]
};
