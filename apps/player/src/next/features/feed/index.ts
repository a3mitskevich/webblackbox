import type { PlayerLocale } from "../../../lib/i18n.js";
import type { PlayerFeature } from "../types.js";
import { ActivityPanel } from "./activity-panel.js";
import { countActivity, feedStepItems } from "./feed-view.js";
import { feedMessages } from "./messages.js";

/**
 * Activity feed and problems strip (R2): the "activity" rail tab (action → consequences feed with
 * "Errors only" / "Hide third-party") — the problems strip above the stage is `ProblemsStrip`.
 */
export const feedFeature: PlayerFeature = {
  id: "feed",
  messages: feedMessages,
  railTabs: [
    {
      id: "activity",
      label: (locale: PlayerLocale) => feedMessages.translate(locale, "tabLabel"),
      count: countActivity,
      Panel: ActivityPanel,
      stepItems: feedStepItems
    }
  ]
};

export { ProblemsStrip } from "./problems-strip.js";
export { useScrubHover } from "./scrub-hover.js";
export { describeFeedEvent, type FeedRowText } from "./feed-view.js";
