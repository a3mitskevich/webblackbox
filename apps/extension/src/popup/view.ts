import type { CaptureMode } from "@webblackbox/protocol";

import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { FullModeVisualCapture, SessionListItem } from "../shared/messages.js";
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

const DEFAULT_RING_BUFFER_MINUTES = 10;

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

export type SegmentOption<TValue extends string> = { value: TValue; label: string };

/** One-row radio group styled as a segmented control; native radios keep keyboard support. */
export function createSegmentedControl<TValue extends string>(options: {
  label: string;
  name: string;
  value: TValue;
  disabled?: boolean;
  segments: Array<SegmentOption<TValue>>;
}): HTMLElement {
  const labelId = `wb-segmented-${options.name}`;
  const group = el("div", {
    className: "wb-segmented__options",
    attrs: { role: "radiogroup", "aria-labelledby": labelId }
  });

  for (const segment of options.segments) {
    const input = el("input", {
      className: "wb-segmented__input",
      attrs: { type: "radio", name: options.name, value: segment.value }
    });
    input.checked = segment.value === options.value;
    input.disabled = options.disabled ?? false;
    group.append(
      el("label", { className: "wb-segmented__option" }, [
        input,
        el("span", { text: segment.label })
      ])
    );
  }

  return el("div", { className: "wb-segmented" }, [
    el("span", { className: "wb-segmented__label", text: options.label, attrs: { id: labelId } }),
    group
  ]);
}

export function createStateLine(text: string, incident: string | null): HTMLElement {
  const line = el("p", { className: "wb-popup__state" }, [el("span", { text })]);

  if (incident) {
    line.append(el("strong", { className: "wb-popup__incident", text: incident }));
  }

  return line;
}

export type RingUsage = { usedMinutes: number; capacityMinutes: number; windowLabel: string };

export function describeRingBufferUsage(
  session: SessionListItem,
  now: number,
  format: Pick<PopupFormatters, "t" | "formatNumber">
): RingUsage {
  const capacityMinutes = Math.max(
    1,
    Number.isFinite(session.ringBufferMinutes)
      ? Number(session.ringBufferMinutes)
      : DEFAULT_RING_BUFFER_MINUTES
  );
  const endedAt = typeof session.stoppedAt === "number" ? session.stoppedAt : now;
  const elapsedMinutes = Math.max(0, (endedAt - session.startedAt) / 60_000);
  const usedMinutes = Math.min(capacityMinutes, elapsedMinutes);

  return {
    usedMinutes,
    capacityMinutes,
    windowLabel: format.t("popupRingBufferWindow", {
      used: format.formatNumber(usedMinutes, 1),
      capacity: format.formatNumber(capacityMinutes, 1)
    })
  };
}

function createStats(
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

function sessionMeta(session: SessionListItem, now: number, format: PopupFormatters): string {
  return [
    format.formatMode(session.mode),
    ...(session.profileName ? [session.profileName] : []),
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

  const ring = describeRingBufferUsage(session, now, format);
  const meter = el("progress", {
    className: "wb-popup__buffer-meter",
    attrs: { "aria-label": t("popupRingBuffer"), "aria-valuetext": ring.windowLabel }
  });
  meter.max = Math.round(ring.capacityMinutes * 100);
  meter.value = Math.round(ring.usedMinutes * 100);

  return el("section", { className: "wb-panel wb-panel--live wb-popup__live" }, [
    panelHead(t("popupRecordingTitle"), sessionMeta(session, now, format)),
    createStats(session, format, { compact: false }),
    el("div", { className: "wb-popup__buffer" }, [
      el("p", { className: "wb-popup__buffer-label" }, [
        el("span", { text: t("popupRingBuffer") }),
        el("strong", { text: ring.windowLabel })
      ]),
      meter
    ]),
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

const VISUAL_SEGMENTS: Array<{ value: FullModeVisualCapture; key: ExtensionMessageKey }> = [
  { value: "screenshots", key: "popupVisualShots" },
  { value: "recording", key: "popupVisualVideo" },
  { value: "both", key: "popupFullVisualBoth" },
  { value: "none", key: "popupFullVisualNone" }
];

export function visualCaptureLabel(t: Translate, value: FullModeVisualCapture): string {
  const segment = VISUAL_SEGMENTS.find((entry) => entry.value === value);
  return segment ? t(segment.key) : value;
}

export function createStartPanel(options: {
  t: Translate;
  profilePicker: HTMLElement;
  engine: CaptureMode;
  visualCapture: FullModeVisualCapture;
  pinnedVisual?: FullModeVisualCapture;
  pending: boolean;
}): HTMLElement {
  const { t } = options;
  const panel = el("section", { className: "wb-panel wb-popup__start" }, [
    options.profilePicker,
    createSegmentedControl<CaptureMode>({
      label: t("popupEngineLabel"),
      name: "capture-mode",
      value: options.engine,
      disabled: options.pending,
      segments: [
        { value: "lite", label: t("modeLite") },
        { value: "full", label: t("modeFull") }
      ]
    })
  ]);

  if (options.engine === "full") {
    panel.append(
      options.pinnedVisual
        ? el("p", {
            className: "wb-popup__hint",
            text: t("popupVisualPinned", { value: visualCaptureLabel(t, options.pinnedVisual) })
          })
        : createSegmentedControl<FullModeVisualCapture>({
            label: t("popupVisualLabel"),
            name: "full-visual-capture",
            value: options.visualCapture,
            disabled: options.pending,
            segments: VISUAL_SEGMENTS.map((segment) => ({
              value: segment.value,
              label: t(segment.key)
            }))
          })
    );
  }

  panel.append(
    actionButton(options.pending ? t("popupStarting") : t("popupStart"), "start", "brand", {
      disabled: options.pending,
      block: true,
      iconName: "play"
    })
  );
  return panel;
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
    createStats(session, format, { compact: true }),
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
  return el("section", { className: "wb-popup__privacy-warning", attrs: { role: "alert" } }, [
    el("strong", { text: title }),
    el("p", { text })
  ]);
}
