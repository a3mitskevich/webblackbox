import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { createPlainArchive } from "../../../../scripts/lib/synthetic-session.mjs";
import { buildArchiveModel } from "../../../core/archive-model.js";
import { buildSessionView } from "../../../core/session-view.js";
import { createInitialState, type LoadedArchive, type PlayerState } from "../../state.js";
import { buildNetworkView, getNetworkModel, isRowFailed, selectionOfRow } from "./rows.js";
import { networkSlice } from "./slice.js";
import { labelStreamMessages, shownStream } from "./message-labels.js";
import { networkStepItems, realtimeStepItems } from "./step-items.js";

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

describe("realtimeStepItems", () => {
  it("steps through the shown connection's messages, without service ones when hidden", () => {
    const model = getNetworkModel(archive);
    const stream = shownStream(model, null, null);
    const all = realtimeStepItems(archive, stateWith({}));
    const withoutService = realtimeStepItems(archive, stateWith({ hideService: true }));

    expect(stream).not.toBeNull();
    expect(all.map((item) => item.selection)).toEqual(
      stream?.messages.map((entry) => ({ kind: "event", id: entry.eventId }))
    );
    expect(withoutService).toHaveLength(stream ? labelStreamMessages(stream, true).length : 0);
    expect(withoutService.length).toBeLessThanOrEqual(all.length);
  });

  it("follows the connection of the selected event", () => {
    const model = getNetworkModel(archive);
    const other = model.streams.find((stream) => stream !== shownStream(model, null, null));
    const message = other?.messages[0];

    if (!other || !message) {
      return;
    }

    const state = { ...stateWith({}), selection: { kind: "event" as const, id: message.eventId } };
    expect(realtimeStepItems(archive, state).map((item) => item.mono)).toEqual(
      other.messages.map((entry) => entry.mono)
    );
  });
});
