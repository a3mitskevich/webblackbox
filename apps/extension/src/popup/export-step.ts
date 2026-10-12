import type { CaptureFallback, CaptureFallbackReason } from "../shared/capture-fallback.js";
import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { SessionListItem } from "../shared/messages.js";
import { el } from "../shared/ui/dom.js";
import {
  actionButton,
  createSessionStats,
  sessionMeta,
  type PopupFormatters,
  type Translate
} from "./view.js";

/** DOM builders for what follows Stop (the export step) and for a Full → Light fallback. */

const FALLBACK_REASON_KEYS: Record<CaptureFallbackReason, ExtensionMessageKey> = {
  "restricted-page": "popupFallbackRestrictedPage",
  "attach-failed": "popupFallbackAttachFailed",
  "canceled-by-user": "popupFallbackCanceledByUser",
  "target-closed": "popupFallbackTargetClosed",
  detached: "popupFallbackDetached"
};

/** Why the recording runs (or ran) in Light and what that leaves out. */
export function createCaptureFallbackWarning(fallback: CaptureFallback, t: Translate): HTMLElement {
  return el(
    "section",
    {
      className: "wb-popup__alert wb-popup__fallback",
      attrs: { role: "alert" },
      dataset: { captureFallback: fallback.reason }
    },
    [
      el("strong", { text: t("popupFallbackTitle") }),
      el("p", { text: t(FALLBACK_REASON_KEYS[fallback.reason]) }),
      el("p", { text: t("popupFallbackLost") })
    ]
  );
}

/** "Passphrase remembered until the browser closes · Forget", or what the first export asks. */
export function createPassphraseLine(remembered: boolean, t: Translate): HTMLElement {
  if (!remembered) {
    return el("p", {
      className: "wb-popup__hint",
      text: t("popupPassphraseAsked"),
      dataset: { passphraseState: "ask" }
    });
  }

  return el("p", { className: "wb-popup__hint", dataset: { passphraseState: "remembered" } }, [
    t("popupPassphraseRemembered"),
    " · ",
    el("button", {
      className: "wb-link-btn",
      text: t("popupPassphraseForget"),
      attrs: { type: "button" },
      dataset: { action: "forget-passphrase" }
    })
  ]);
}

/**
 * The step right after Stop: export now (the main action) or later. The recording stays on the
 * device until it is exported or deleted either way.
 */
export function createExportStepPanel(options: {
  session: SessionListItem;
  now: number;
  format: PopupFormatters;
  exporting: boolean;
  passphraseRemembered: boolean;
  limitsText: string;
}): HTMLElement {
  const { session, format } = options;
  const { t } = format;

  return el(
    "section",
    { className: "wb-panel wb-popup__export-step", dataset: { exportStep: "" } },
    [
      el("div", { className: "wb-panel__head" }, [
        el("h2", { className: "wb-panel__title", text: t("popupExportStepTitle") }),
        el("span", { className: "wb-panel__meta", text: sessionMeta(session, options.now, format) })
      ]),
      el("p", { className: "wb-popup__hint", text: t("popupExportStepBody") }),
      ...(session.interruption
        ? [
            el("p", { className: "wb-popup__hint", dataset: { interrupted: "" } }, [
              el("span", {
                className: "wb-badge wb-badge--alert",
                text: t("popupInterruptedBadge")
              }),
              ` ${t("popupInterruptedHint")}`
            ])
          ]
        : []),
      ...(session.captureFallback
        ? [createCaptureFallbackWarning(session.captureFallback, t)]
        : []),
      createSessionStats(session, format, { compact: true }),
      actionButton(
        options.exporting ? t("popupExporting") : t("popupExportNow"),
        "export",
        "brand",
        { disabled: options.exporting, block: true, iconName: "download" }
      ),
      el("div", { className: "wb-popup__export-row" }, [
        el("span", { className: "wb-popup__hint", text: options.limitsText }),
        actionButton(t("popupExportLater"), "export-later", "surface", {
          disabled: options.exporting
        })
      ]),
      createPassphraseLine(options.passphraseRemembered, t)
    ]
  );
}
