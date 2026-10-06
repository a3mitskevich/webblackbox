import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { compareMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => compareMessages.translate(locale, "tabLabel");

/** Its own chunk: the panel brings jsdiff and microdiff with it. */
const ComparePanel = lazy(() => import("./compare-panel.js"));

/**
 * Compare + regressions (R4): the open archive against a second recording, as the last rail tab
 * (key 8, `#tab=compare`). Session B lives in the compare slice and survives tab switches.
 */
export const compareFeature: PlayerFeature = {
  id: "compare",
  messages: compareMessages,
  railTabs: [{ id: "compare", label, Panel: ComparePanel }]
};
