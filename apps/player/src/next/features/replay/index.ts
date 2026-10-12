import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { replayMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => replayMessages.translate(locale, "tabLabel");

/** Its own chunk; rrweb itself runs only inside the sandboxed replay frame. */
const ReplayPanel = lazy(() => import("./replay-panel.js"));

/** DOM replay (spike, task 56): the rrweb log replayed in a sandboxed frame. */
export const replayFeature: PlayerFeature = {
  id: "replay",
  messages: replayMessages,
  railTabs: [{ id: "replay", label, Panel: ReplayPanel }]
};
