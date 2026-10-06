import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { countConsoleErrors } from "./console-model.js";
import { consoleMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => consoleMessages.translate(locale, "tabLabel");

/** The panel, its stylesheet and the stack view load with the tab's own chunk. */
const ConsolePanel = lazy(() => import("./console-panel.js"));

/** Console (R4): console output and errors with symbolicated stacks; the count is the errors. */
export const consoleFeature: PlayerFeature = {
  id: "console",
  messages: consoleMessages,
  railTabs: [
    {
      id: "console",
      label,
      count: (archive) => countConsoleErrors(archive),
      isAlert: (count) => count > 0,
      Panel: ConsolePanel
    }
  ]
};
