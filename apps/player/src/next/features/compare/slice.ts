import type { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import { defineFeatureSlice } from "../slice.js";

/** Where opening the comparison archive (session B) stands. */
export type CompareStatus =
  | { phase: "empty" }
  | { phase: "loading"; fileName: string }
  | { phase: "passphrase"; fileName: string; invalid: boolean }
  | { phase: "error"; fileName: string; message: string }
  | { phase: "ready" };

export type CompareArchive = {
  fileName: string;
  player: WebBlackboxPlayer;
};

export type CompareSlice = {
  status: CompareStatus;
  /** Session B; session A is the archive open in the player. */
  other: CompareArchive | null;
  /** The aligned endpoint whose bodies and headers are diffed. */
  selectedKey: string | null;
};

declare module "../../state.js" {
  interface FeatureSlices {
    compare: CompareSlice;
  }
}

export const compareSlice = defineFeatureSlice("compare", {
  status: { phase: "empty" },
  other: null,
  selectedKey: null
});
