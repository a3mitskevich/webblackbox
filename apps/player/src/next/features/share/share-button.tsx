import "./share.css";

import { Menu } from "@base-ui/react/menu";
import { Link2, Share2, Upload } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";

import { useController, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice } from "../slice.js";
import { shareMessages } from "./messages.js";
import { decideShareLink, loadSharedArchive } from "./share-service.js";
import { shareSlice, type ShareSlice } from "./slice.js";

/** The dialogs (privacy preflight, upload, open by reference) load on first use. */
const ShareDialogs = lazy(() => import("./share-dialogs.js"));

const ICON_PROPS = { size: 16, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };
const selectDialog = (slice: ShareSlice) => slice.dialog;

/** `?share=` on load: trusted servers load at once; others ask first (never saved). */
function useShareLinkOnLoad(): void {
  const controller = useController();
  const t = useFeatureI18n(shareMessages);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || typeof window === "undefined") {
      return;
    }

    handled.current = true;
    const decision = decideShareLink(window.location.href, window.location.origin);

    if (decision.kind === "invalid") {
      controller.store.setState((state) => ({ ...state, announcement: t("invalidReference") }));
      return;
    }

    if (decision.kind === "trusted") {
      void loadSharedArchive(controller, {
        reference: decision.reference,
        apiKey: decision.apiKey,
        persist: false,
        messages: { failed: (error) => t("loadFailed", { error }), invalid: t("invalidReference") }
      });
      return;
    }

    if (decision.kind === "confirm") {
      shareSlice.update(controller.store, (slice) => ({
        ...slice,
        dialog: { kind: "open", reference: decision.reference, untrustedOrigin: decision.origin }
      }));
    }
  }, [controller, t]);
}

/**
 * Header "Share": upload the open recording to a share server (after a privacy check) and copy
 * the link, or open a shared recording by link or id. Also handles `?share=` links on load.
 */
export function ShareButton() {
  const controller = useController();
  const t = useFeatureI18n(shareMessages);
  const hasArchive = usePlayerState((state) => state.archive !== null);
  const dialog = useFeatureSlice(shareSlice, selectDialog);

  useShareLinkOnLoad();

  const openDialog = (next: ShareSlice["dialog"]): void =>
    shareSlice.update(controller.store, (slice) => ({
      ...slice,
      dialog: next,
      ...(next?.kind === "upload" ? { upload: { phase: "idle" } as const } : {}),
      ...(next?.kind === "open" ? { open: { phase: "idle" } as const } : {})
    }));

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="btn" data-testid="share-button" aria-label={t("share")}>
          <Share2 {...ICON_PROPS} />
          <span className="lbl hide-narrow">{t("share")}</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="share-menu-layer">
            <Menu.Popup className="share-menu" data-testid="share-menu">
              <Menu.Item
                className="share-menu-item"
                disabled={!hasArchive}
                onClick={() => openDialog({ kind: "upload" })}
                data-testid="share-upload-item"
              >
                <Upload {...ICON_PROPS} />
                {t("shareThis")}
              </Menu.Item>
              <Menu.Item
                className="share-menu-item"
                onClick={() => openDialog({ kind: "open", reference: "" })}
                data-testid="share-open-item"
              >
                <Link2 {...ICON_PROPS} />
                {t("openShared")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {dialog ? (
        <Suspense fallback={null}>
          <ShareDialogs />
        </Suspense>
      ) : null}
    </>
  );
}
