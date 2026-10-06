import { lazy } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { storageMessages } from "./messages.js";

const label = (locale: PlayerLocale): string => storageMessages.translate(locale, "tabLabel");

/** Its own chunk (with jsdiff and microdiff for value diffs). */
const StoragePanel = lazy(() => import("./storage-panel.js"));

/** Storage (R4): storage at the playhead and the log of writes. */
export const storageFeature: PlayerFeature = {
  id: "storage",
  messages: storageMessages,
  railTabs: [
    {
      id: "storage",
      label,
      count: (archive) => archive.model.storage.length,
      Panel: StoragePanel
    }
  ]
};
