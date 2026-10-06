import { useMemo } from "react";

import { usePlayerState } from "../../context.js";
import { shallowEqual } from "../../store.js";
import { useFeatureSlice } from "../slice.js";
import {
  buildNetworkView,
  getNetworkModel,
  rowOfSelection,
  type NetworkModel,
  type NetworkRow,
  type NetworkSort,
  type NetworkView
} from "./rows.js";
import { networkSlice, type NetworkSlice } from "./slice.js";

/** The list re-renders "past / future" at most this often while playing. */
export const NOW_BUCKET_MS = 120;

export function useNetworkModel(): NetworkModel | null {
  const archive = usePlayerState((state) => state.archive);
  return useMemo(() => (archive ? getNetworkModel(archive) : null), [archive]);
}

const selectChips = (slice: NetworkSlice) => ({
  type: slice.type,
  failedOnly: slice.failedOnly,
  notCapturedOnly: slice.notCapturedOnly,
  hideThirdParty: slice.hideThirdParty
});
const selectSort = (slice: NetworkSlice): NetworkSort => slice.sort;

/** The visible rows, chip counts and hidden third-party count for the current filters. */
export function useNetworkView(model: NetworkModel | null): NetworkView | null {
  const query = usePlayerState((state) => state.query);
  const locale = usePlayerState((state) => state.locale);
  const chips = useFeatureSlice(networkSlice, selectChips, shallowEqual);
  const sort = useFeatureSlice(networkSlice, selectSort);
  const range = usePlayerState((state) => state.range);

  return useMemo(
    () => (model ? buildNetworkView(model, { query, ...chips, range }, sort, locale) : null),
    [model, query, chips, sort, locale, range]
  );
}

/** The row of the player-wide selection (a request, or any event of a request or socket). */
export function useSelectedRow(model: NetworkModel | null): NetworkRow | null {
  const selection = usePlayerState((state) => state.selection);
  return useMemo(() => (model ? rowOfSelection(model, selection) : null), [model, selection]);
}

/** The playhead, exact while paused and in NOW_BUCKET_MS steps while playing. */
export function useNowMono(): number {
  return usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / NOW_BUCKET_MS) * NOW_BUCKET_MS
      : state.playheadMono
  );
}
