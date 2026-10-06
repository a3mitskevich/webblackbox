import type { ConsoleLevel } from "@webblackbox/player-sdk";

import { defineFeatureSlice } from "../slice.js";

/** How the console stack shows frames: mapped through source maps, or as recorded. */
export type StackMode = "original" | "minified";

export type ConsoleSlice = {
  /** Levels the list is narrowed to; empty shows every level. */
  levels: readonly ConsoleLevel[];
  groupSimilar: boolean;
  hideThirdParty: boolean;
  /** The row whose stack and details are open (its first event id). */
  expandedId: string | null;
  stackMode: StackMode;
};

declare module "../../state.js" {
  interface FeatureSlices {
    console: ConsoleSlice;
  }
}

export const consoleSlice = defineFeatureSlice("console", {
  levels: [],
  groupSimilar: true,
  hideThirdParty: true,
  expandedId: null,
  stackMode: "original"
});
