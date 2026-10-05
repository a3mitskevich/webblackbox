import { SHORTCUT_SHEET, type ShortcutAction } from "../../core/keymap.js";
import type { NextMessageKey } from "../../lib/i18n.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import { DialogTitle, ModalDialog } from "./modal-dialog.js";

const ACTION_KEYS: Record<ShortcutAction, NextMessageKey> = {
  togglePlay: "keyTogglePlay",
  seekStep: "keySeekStep",
  seekLargeStep: "keySeekLargeStep",
  seekFrame: "keySeekFrame",
  seekEdges: "keySeekEdges",
  stepList: "keyStepList",
  stepError: "keyStepError",
  nextAction: "keyNextAction",
  search: "keySearch",
  tabs: "keyTabs",
  details: "keyDetails",
  railWide: "keyRailWide",
  shortcuts: "keyShortcuts"
};

export function ShortcutsDialog() {
  const controller = useController();
  const i18n = useI18n();
  const open = usePlayerState((state) => state.shortcutsOpen);

  return (
    <ModalDialog
      open={open}
      onClose={() => controller.setShortcutsOpen(false)}
      className="dlg-wide"
      testId="shortcuts-dialog"
    >
      <div className="dlg-body">
        <DialogTitle>{i18n.tn("shortcutsTitle")}</DialogTitle>
        <table className="keys">
          <thead>
            <tr>
              <th scope="col">{i18n.tn("shortcutKeysLabel")}</th>
              <th scope="col">{i18n.tn("shortcutActionLabel")}</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUT_SHEET.map((row) => (
              <tr key={row.action}>
                <td>
                  {row.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </td>
                <td>{i18n.tn(ACTION_KEYS[row.action])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dlg-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => controller.setShortcutsOpen(false)}
          >
            {i18n.tn("close")}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
