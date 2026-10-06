import type { ListStepItem } from "../../controller.js";
import type { LoadedArchive, PlayerState } from "../../state.js";
import { buildNetworkView, getNetworkModel, selectionOfRow, type NetworkSort } from "./rows.js";
import { networkSlice } from "./slice.js";

const TIME_ORDER: NetworkSort = { key: "start", direction: "asc" };

/** J / L in the Network tab: the rows the current filters show, in time order (any column sort). */
export function networkStepItems(archive: LoadedArchive, state: PlayerState): ListStepItem[] {
  const slice = networkSlice.select(state);
  const view = buildNetworkView(
    getNetworkModel(archive),
    {
      query: state.query,
      type: slice.type,
      failedOnly: slice.failedOnly,
      notCapturedOnly: slice.notCapturedOnly,
      hideThirdParty: slice.hideThirdParty
    },
    TIME_ORDER,
    state.locale
  );

  return view.rows.flatMap((row) => {
    const selection = selectionOfRow(row);
    return selection ? [{ selection, mono: row.startMono }] : [];
  });
}
