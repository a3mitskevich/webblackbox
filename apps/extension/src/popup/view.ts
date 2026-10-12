import type { CaptureMode } from "@webblackbox/protocol";

import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { SessionListItem } from "../shared/messages.js";
import { displayProfileName } from "../shared/profiles/display-name.js";
import { el } from "../shared/ui/dom.js";
import { icon, type IconName } from "../shared/ui/icons.js";

/** DOM builders for the popup; state and actions stay in index.ts. */

export type Translate = (
  key: ExtensionMessageKey,
  vars?: Record<string, string | number>
) => string;

export type PopupFormatters = {
  t: Translate;
  formatMode: (mode: CaptureMode) => string;
  formatRelativeTime: (timestamp: number, now: number) => string;
  formatDuration: (startedAt: number, endedAt: number) => string;
  formatByteSize: (bytes: number) => string;
  formatNumber: (value: number, fractionDigits?: number) => string;
};

export type BadgeKind = "idle" | "rec" | "alert";

type ButtonVariant = "brand" | "accent" | "muted" | "surface" | "danger";

export function createPopupHeader(options: {
  t: Translate;
  version: string;
  badge: BadgeKind;
  tabId: number | null;
}): HTMLElement {
  const { t } = options;
  const badgeText =
    options.badge === "alert"
      ? t("popupBadgeAlert")
      : options.badge === "rec"
        ? t("popupBadgeRecording")
        : t("popupBadgeIdle");

  return el("header", { className: "wb-popup__header" }, [
    el("img", {
      className: "wb-popup__logo",
      attrs: { src: "./icon/32.png", alt: "", width: "20", height: "20" }
    }),
    el("h1", {
      className: "wb-popup__title",
      text: "WebBlackbox",
      attrs: { title: `WebBlackbox v${options.version}` }
    }),
    el("span", {
      className: `wb-badge wb-badge--${options.badge}`,
      text: badgeText
    }),
    el("span", {
      className: "wb-popup__tab",
      text: t("popupTabLabel", { tabId: options.tabId ?? "—" }),
      attrs: { title: t("popupTabTitle", { tabId: options.tabId ?? "—" }) }
    }),
    el("span", { className: "wb-popup__spacer" }),
    iconButton(t("popupSessions"), "open-sessions", "sessions"),
    iconButton(t("popupOptions"), "open-options", "settings")
  ]);
}

export function iconButton(label: string, action: string, name: IconName): HTMLButtonElement {
  return el(
    "button",
    {
      className: "wb-icon-btn",
      attrs: { type: "button", "aria-label": label, title: label },
      dataset: { action }
    },
    [icon(name)]
  );
}

export function actionButton(
  label: string,
  action: string,
  variant: ButtonVariant,
  options: { disabled?: boolean; block?: boolean; iconName?: IconName } = {}
): HTMLButtonElement {
  const button = el(
    "button",
    {
      className: `wb-btn wb-btn--${variant}${options.block ? " wb-btn--block" : ""}`,
      attrs: { type: "button" },
      dataset: { action }
    },
    [...(options.iconName ? [icon(options.iconName)] : []), label]
  );
  button.disabled = options.disabled ?? false;
  return button;
}

export function createStateLine(text: string, incident: string | null): HTMLElement {
  const line = el("p", { className: "wb-popup__state" }, [el("span", { text })]);

  if (incident) {
    line.append(el("strong", { className: "wb-popup__incident", text: incident }));
  }

  return line;
}

export function createSessionStats(
  session: SessionListItem,
  format: PopupFormatters,
  options: { compact: boolean }
): HTMLElement {
  const { t } = format;
  const errorCount = session.errorCount ?? 0;
  const stats: Array<{ label: string; value: string; warn: boolean }> = [
    {
      label: t("popupStatEvents"),
      value: format.formatNumber(session.eventCount ?? 0),
      warn: false
    },
    { label: t("popupStatErrors"), value: format.formatNumber(errorCount), warn: errorCount > 0 },
    {
      label: t("popupStatAlerts"),
      value: format.formatNumber(session.budgetAlertCount ?? 0),
      warn: false
    },
    { label: t("popupStatSize"), value: format.formatByteSize(session.sizeBytes ?? 0), warn: false }
  ];

  return el(
    "dl",
    { className: options.compact ? "wb-stats wb-stats--compact" : "wb-stats" },
    stats.map((stat) =>
      el(
        "div",
        { className: stat.warn ? "wb-stats__item wb-stats__item--warn" : "wb-stats__item" },
        [el("dt", { text: stat.label }), el("dd", { text: stat.value })]
      )
    )
  );
}

export function sessionMeta(
  session: SessionListItem,
  now: number,
  format: PopupFormatters
): string {
  return [
    format.formatMode(session.mode),
    ...(session.profileName
      ? [displayProfileName({ id: session.profileId, name: session.profileName }, format.t)]
      : []),
    session.active
      ? format.formatDuration(session.startedAt, now)
      : format.formatRelativeTime(session.stoppedAt ?? session.startedAt, now)
  ].join(" · ");
}

function panelHead(title: string, meta: string): HTMLElement {
  return el("div", { className: "wb-panel__head" }, [
    el("h2", { className: "wb-panel__title", text: title }),
    el("span", { className: "wb-panel__meta", text: meta })
  ]);
}

export function createRecordingPanel(options: {
  session: SessionListItem;
  onCurrentTab: boolean;
  now: number;
  format: PopupFormatters;
}): HTMLElement {
  const { session, format, now } = options;
  const { t } = format;

  if (!options.onCurrentTab) {
    return createOtherTabRecordingRow(session, now, format);
  }

  return el("section", { className: "wb-panel wb-panel--live wb-popup__live" }, [
    panelHead(t("popupRecordingTitle"), sessionMeta(session, now, format)),
    createSessionStats(session, format, { compact: false }),
    el("div", { className: "wb-popup__row" }, [
      actionButton(t("popupMarker"), "marker", "surface", { iconName: "marker" }),
      actionButton(t("popupStop"), "stop", "danger", { iconName: "stop" })
    ])
  ]);
}

/**
 * A recording on another tab: one row with Stop. Its counters and Marker belong to that tab, and
 * this tab still needs room for Start and its last session within the 600px popup.
 */
function createOtherTabRecordingRow(
  session: SessionListItem,
  now: number,
  format: PopupFormatters
): HTMLElement {
  const { t } = format;
  const stop = actionButton(t("popupStop"), "stop", "danger", { iconName: "stop" });
  stop.classList.add("wb-btn--small");

  return el(
    "section",
    { className: "wb-panel wb-panel--live wb-popup__live wb-popup__live--other" },
    [
      el("div", { className: "wb-popup__live-row" }, [
        panelHead(
          t("popupRecordingOnTab", { tabId: session.tabId }),
          `${format.formatMode(session.mode)} · ${format.formatDuration(session.startedAt, now)}`
        ),
        stop
      ])
    ]
  );
}

/** The default path: one Record button under the profile it records with. */
export function createRecordPanel(options: {
  t: Translate;
  profileLine: HTMLElement;
  pending: boolean;
}): HTMLElement {
  const { t } = options;

  return el("section", { className: "wb-panel wb-popup__start" }, [
    options.profileLine,
    actionButton(options.pending ? t("popupStarting") : t("popupRecord"), "start", "brand", {
      disabled: options.pending,
      block: true,
      iconName: "play"
    })
  ]);
}

export function createLastSessionPanel(options: {
  session: SessionListItem;
  now: number;
  format: PopupFormatters;
  exporting: boolean;
  limitsText: string;
}): HTMLElement {
  const { session, format } = options;
  const { t } = format;

  return el("section", { className: "wb-panel wb-popup__last" }, [
    panelHead(t("popupLastSessionTitle"), sessionMeta(session, options.now, format)),
    ...(session.interruption
      ? [
          el("p", { className: "wb-popup__hint", dataset: { interrupted: "" } }, [
            el("span", { className: "wb-badge wb-badge--alert", text: t("popupInterruptedBadge") }),
            ` ${t("popupInterruptedHint")}`
          ])
        ]
      : []),
    createSessionStats(session, format, { compact: true }),
    el("div", { className: "wb-popup__export-row" }, [
      el("span", { className: "wb-popup__hint", text: options.limitsText }),
      actionButton(t("popupExport"), "export", "accent", {
        disabled: options.exporting,
        iconName: "download"
      })
    ])
  ]);
}

export function createPrivacyWarning(title: string, text: string): HTMLElement {
  return el("section", { className: "wb-popup__privacy-warning", attrs: { role: "status" } }, [
    el("strong", { text: title }),
    el("p", { text })
  ]);
}
