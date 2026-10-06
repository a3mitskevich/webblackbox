import { defineFeatureSlice } from "../slice.js";
import type { NetworkSort, NetworkTypeChip } from "./rows.js";

export type NetworkDetailTab =
  | "headers"
  | "payload"
  | "response"
  | "timing"
  | "initiator"
  | "messages";

export type BodyView = "tree" | "raw" | "hex";

/** Network and Realtime tab state; the text filter is the player-wide `query`. */
export type NetworkSlice = {
  type: NetworkTypeChip;
  failedOnly: boolean;
  notCapturedOnly: boolean;
  /** Third-party requests hidden by default (owner decision, PROPOSAL "Решения владельца"). */
  hideThirdParty: boolean;
  sort: NetworkSort;
  detailTab: NetworkDetailTab;
  bodyView: BodyView;
  maskSecrets: boolean;
  /** Handshakes, pings and empty completions left out of conversations. */
  hideService: boolean;
  /** Realtime tab: the stream shown while the selection is not one of its events. */
  realtimeStreamKey: string | null;
};

declare module "../../state.js" {
  interface FeatureSlices {
    network: NetworkSlice;
  }
}

export const networkSlice = defineFeatureSlice("network", {
  type: "all",
  failedOnly: false,
  notCapturedOnly: false,
  hideThirdParty: true,
  sort: { key: "start", direction: "asc" },
  detailTab: "headers",
  bodyView: "tree",
  maskSecrets: true,
  hideService: false,
  realtimeStreamKey: null
} satisfies NetworkSlice);
