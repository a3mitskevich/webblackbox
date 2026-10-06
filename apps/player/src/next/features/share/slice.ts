import { defineFeatureSlice } from "../slice.js";

export type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; loaded: number; total: number }
  | { phase: "done"; shareUrl: string }
  | { phase: "error"; message: string };

export type OpenSharedState =
  { phase: "idle" } | { phase: "loading" } | { phase: "error"; message: string };

export type ShareDialog =
  | { kind: "upload" }
  /** `untrustedOrigin`: opened from a `?share=` link to a server the user must confirm. */
  | { kind: "open"; reference: string; untrustedOrigin?: string };

export type ShareSlice = {
  dialog: ShareDialog | null;
  upload: UploadState;
  open: OpenSharedState;
};

declare module "../../state.js" {
  interface FeatureSlices {
    share: ShareSlice;
  }
}

export const shareSlice = defineFeatureSlice("share", {
  dialog: null,
  upload: { phase: "idle" },
  open: { phase: "idle" }
});
