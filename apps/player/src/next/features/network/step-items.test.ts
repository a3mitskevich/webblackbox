import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { buildArchiveModel } from "../../../core/archive-model.js";
import { buildSessionView } from "../../../core/session-view.js";
import { createInitialState, type LoadedArchive, type PlayerState } from "../../state.js";
import { buildNetworkView, getNetworkModel, isRowFailed, selectionOfRow } from "./rows.js";
import { networkSlice } from "./slice.js";
import { networkStepItems } from "./step-items.js";

let archive: LoadedArchive;

beforeAll(async () => {
  const player = await WebBlackboxPlayer.open(await createPlainArchive());
  const model = buildArchiveModel(player, {
    pointerReasonClick: "click",
    pointerReasonMove: "move",
    formatPointerKind: (kind) => kind
  });
  archive = {
    fileName: "synthetic.webblackbox",
    player,
    model,
    view: buildSessionView(player.archive, model)
  };
});

function stateWith(patch: Partial<typeof networkSlice.initial>): PlayerState {
  const state = createInitialState("en", "system");
  return {
    ...state,
    archive,
    slices: { ...state.slices, network: { ...networkSlice.initial, ...patch } }
  };
}

describe("networkStepItems", () => {
  it("steps through the visible rows in time order whatever the column sort", () => {
    const items = networkStepItems(
      archive,
      stateWith({ sort: { key: "time", direction: "desc" } })
    );
    const monos = items.map((item) => item.mono);

    expect(items.length).toBeGreaterThan(1);
    expect(monos).toEqual([...monos].sort((left, right) => left - right));
  });

  it("follows the filters of the table", () => {
    const state = stateWith({ failedOnly: true });
    const failed = buildNetworkView(
      getNetworkModel(archive),
      { query: "", type: "all", failedOnly: true, notCapturedOnly: false, hideThirdParty: true },
      { key: "start", direction: "asc" },
      "en"
    ).rows;

    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every(isRowFailed)).toBe(true);
    expect(networkStepItems(archive, state).map((item) => item.selection)).toEqual(
      failed.map(selectionOfRow)
    );
  });
});
