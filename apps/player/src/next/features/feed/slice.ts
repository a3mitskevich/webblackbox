import { defineFeatureSlice } from "../slice.js";

/** The Activity feed's filters and the repeat groups the user opened. */
export type FeedSlice = {
  errorsOnly: boolean;
  /** Third-party rows are hidden by default (PROPOSAL §4, owner decision). */
  hideThirdParty: boolean;
  /** Event ids of the first items of the expanded "×N" rows. */
  expanded: readonly string[];
};

declare module "../../state.js" {
  interface FeatureSlices {
    feed: FeedSlice;
  }
}

export const feedSlice = defineFeatureSlice("feed", {
  errorsOnly: false,
  hideThirdParty: true,
  expanded: []
});

/** Opens or closes one repeat group. */
export function toggleExpanded(slice: FeedSlice, headEventId: string): FeedSlice {
  return {
    ...slice,
    expanded: slice.expanded.includes(headEventId)
      ? slice.expanded.filter((id) => id !== headEventId)
      : [...slice.expanded, headEventId]
  };
}
