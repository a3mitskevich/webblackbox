import { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import { createPlainArchive } from "../../../scripts/lib/synthetic-session.mjs";
import { buildArchiveModel } from "../../core/archive-model.js";
import { buildSessionView } from "../../core/session-view.js";
import { createPlayerI18n } from "../../lib/i18n.js";
import type { LoadedArchive } from "../state.js";

/** The synthetic archive as the controller would load it (feature unit tests). */
export async function loadSyntheticArchive(
  fileName = "synthetic.webblackbox"
): Promise<LoadedArchive> {
  const bytes = await createPlainArchive();
  const player = await WebBlackboxPlayer.open(bytes);
  const i18n = createPlayerI18n("en");
  const model = buildArchiveModel(player, {
    pointerReasonClick: i18n.messages.pointerReasonActionClick,
    pointerReasonMove: i18n.messages.pointerReasonMove,
    formatPointerKind: i18n.formatPointerKind
  });

  return { fileName, player, model, view: buildSessionView(player.archive, model), bytes };
}
