import type { StorageArea } from "@webblackbox/player-sdk";

import { defineFeatureSlice } from "../slice.js";

/** "State at the playhead" (rebuilt storage) or the log of writes and snapshots. */
export type StorageView = "state" | "log";

export type StorageSlice = {
  view: StorageView;
  area: StorageArea;
};

declare module "../../state.js" {
  interface FeatureSlices {
    storage: StorageSlice;
  }
}

export const storageSlice = defineFeatureSlice("storage", { view: "state", area: "local" });
