import type { ComponentType } from "react";

import type { RailTab } from "../../core/url-hash.js";
import type { PlayerLocale } from "../../lib/i18n.js";
import type { LoadedArchive } from "../state.js";
import type { AnyFeatureMessages } from "./messages.js";

/** The feature folders under `src/next/features/` (one owner stage each, see README). */
export const FEATURE_IDS = [
  "feed",
  "network",
  "console",
  "storage",
  "tabs",
  "perf",
  "compare",
  "share",
  "inspector",
  "generate"
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

/** A rail tab a feature contributes. Its position and digit key come from `RAIL_TABS`. */
export type RailTabRegistration = {
  id: RailTab;
  /** The tab label in a locale (usually from the feature's dictionary). */
  label: (locale: PlayerLocale) => string;
  /**
   * The count shown next to the label; omit for none. Recomputed only when the archive or the
   * filter text changes (never per playback frame), so it may scan the archive.
   */
  count?: (archive: LoadedArchive, query: string) => number;
  /** Shows the count as a problem (red), e.g. console errors. */
  isAlert?: (count: number) => boolean;
  /**
   * The tab panel. Runs inside an error boundary and Suspense, so a `React.lazy` panel loads
   * its own chunk (and CSS) on first use, and a crash degrades only this panel.
   */
  Panel: ComponentType;
};

/** What a feature folder exports from its `index.ts`. */
export type PlayerFeature = {
  id: FeatureId;
  railTabs?: readonly RailTabRegistration[];
  /** The feature's dictionaries (EN/RU/中文), merged into the catalog at startup. */
  messages?: AnyFeatureMessages;
};
