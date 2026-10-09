import {
  EXTENSION_UPDATE_DISMISSED_STORAGE_KEY,
  type ExtensionUpdateNotice
} from "../shared/extension-update.js";
import { normalizePlayerUrl } from "../shared/player-url.js";
import { el } from "../shared/ui/dom.js";
import { actionButton, type Translate } from "./view.js";

/**
 * The popup's "newer extension version" banner: the versions, a button to the Player (its guide
 * has the download and the update steps) and Hide, which hides the notice for that version only.
 */

export const OPEN_UPDATE_GUIDE_ACTION = "open-update-guide";
export const DISMISS_UPDATE_ACTION = "dismiss-update";

type StorageWriter = { set(items: Record<string, unknown>): Promise<void> };

export function createUpdateBanner(notice: ExtensionUpdateNotice, t: Translate): HTMLElement {
  const open = actionButton(t("updateNoticeOpenGuide"), OPEN_UPDATE_GUIDE_ACTION, "brand");
  const dismiss = actionButton(t("updateNoticeDismiss"), DISMISS_UPDATE_ACTION, "surface");
  dismiss.title = t("updateNoticeDismissTitle");
  open.disabled = updateGuideUrl(notice) === null;

  return el(
    "section",
    { className: "wb-popup__update", attrs: { role: "status" }, dataset: { updateNotice: "" } },
    [
      el("strong", {
        text: t("updateNoticeAvailable", {
          latest: notice.latestVersion,
          installed: notice.installedVersion
        })
      }),
      el("p", { text: t("updateNoticeHint") }),
      el("div", { className: "wb-popup__row" }, [open, dismiss])
    ]
  );
}

/**
 * The Player the version came from. The Player has no address for its guide dialog, so its start
 * page is opened; the guide is one click away there. Re-validated: only https or loopback http.
 */
export function updateGuideUrl(notice: ExtensionUpdateNotice): string | null {
  return normalizePlayerUrl(notice.playerUrl) || null;
}

export async function dismissExtensionUpdate(
  storage: StorageWriter | undefined,
  notice: ExtensionUpdateNotice
): Promise<void> {
  await storage?.set({ [EXTENSION_UPDATE_DISMISSED_STORAGE_KEY]: notice.latestVersion });
}
