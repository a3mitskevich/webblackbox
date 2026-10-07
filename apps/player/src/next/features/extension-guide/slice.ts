import type { PlayerState } from "../../state.js";
import type { Store } from "../../store.js";
import { defineFeatureSlice } from "../slice.js";

export type ExtensionGuideSlice = {
  /** The extension guide dialog is open (header menu / empty state). */
  open: boolean;
};

declare module "../../state.js" {
  interface FeatureSlices {
    extensionGuide: ExtensionGuideSlice;
  }
}

export const extensionGuideSlice = defineFeatureSlice("extensionGuide", { open: false });

/** Opens the extension guide from anywhere (the header menu, the empty state). */
export function openExtensionGuide(store: Store<PlayerState>): void {
  extensionGuideSlice.update(store, (slice) => (slice.open ? slice : { open: true }));
}

export function closeExtensionGuide(store: Store<PlayerState>): void {
  extensionGuideSlice.update(store, (slice) => (slice.open ? { open: false } : slice));
}
