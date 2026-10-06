import "./tabs.css";

import { getRelatedTabsAt } from "@webblackbox/player-sdk";
import type {
  RelatedTabChangeKind,
  RelatedTabInfo,
  TabsSnapshotReason
} from "@webblackbox/protocol";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";

import { formatOffset } from "../../../core/format.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { isOwnListKey, nextListIndex, pageRowsOf } from "../network/list-keys.js";
import { tabsMessages, type TabsMessageKey, type TabsTranslate } from "./messages.js";

const NOW_BUCKET_MS = 250;
/** The rows' minimum height (tabs.css `.tb-row`), for PageUp / PageDown. */
const TABS_ROW_HEIGHT = 40;

const CHANGE_KEYS: Readonly<Record<RelatedTabChangeKind, TabsMessageKey>> = {
  opened: "change_opened",
  entered: "change_entered",
  navigated: "change_navigated",
  left: "change_left",
  closed: "change_closed",
  activated: "change_activated",
  deactivated: "change_deactivated",
  updated: "change_updated"
};
const REASON_KEYS: Readonly<Record<TabsSnapshotReason, TabsMessageKey>> = {
  start: "reason_start",
  "profile-change": "reason_profileChange",
  "origin-change": "reason_originChange"
};

/** One row of the tabs log: a snapshot of all other tabs, or one tab's change. */
type TabsLogRow = {
  eventId: string;
  mono: number;
  kind: "snapshot" | "change";
  /** The protocol value (change kind or snapshot reason): `data-kind` and the CSS class. */
  label: string;
  tab?: RelatedTabInfo;
  openCount: number;
};

function buildLog(archive: LoadedArchive): TabsLogRow[] {
  const { snapshots, changes } = archive.model.tabsContext;
  const rows: TabsLogRow[] = [
    ...snapshots.map(
      (snapshot): TabsLogRow => ({
        eventId: snapshot.eventId,
        mono: snapshot.mono,
        kind: "snapshot",
        label: snapshot.reason,
        openCount: snapshot.tabs.length
      })
    ),
    ...changes.map(
      (change): TabsLogRow => ({
        eventId: change.eventId,
        mono: change.mono,
        kind: "change",
        label: change.change,
        tab: change.tab,
        openCount: change.openCount
      })
    )
  ];

  return rows.sort((left, right) => left.mono - right.mono);
}

/** The localized text of a change kind or snapshot reason (a value from a newer recorder as is). */
function labelText(row: TabsLogRow, t: TabsTranslate): string {
  const keys: Readonly<Record<string, TabsMessageKey>> =
    row.kind === "snapshot" ? REASON_KEYS : CHANGE_KEYS;
  const key = Object.hasOwn(keys, row.label) ? keys[row.label] : undefined;
  const text = key ? t(key) : row.label;

  return row.kind === "snapshot" ? t("snapshot", { reason: text }) : text;
}

const optionId = (row: TabsLogRow): string => `tabs-change-${row.eventId}`;

function TabWhere({ tab }: { tab: RelatedTabInfo }) {
  return (
    <span className="tb-where mono" title={`${tab.origin}${tab.path ?? ""}`}>
      {tab.origin.replace(/^https?:\/\//u, "")}
      <span className="path">{tab.path ?? ""}</span>
    </span>
  );
}

function TabFlags({ tab, t }: { tab: RelatedTabInfo; t: TabsTranslate }) {
  const flags = [
    tab.active ? t("flagActive") : null,
    tab.focused ? t("flagFocused") : null,
    tab.incognito ? t("flagIncognito") : null,
    tab.discarded ? t("flagDiscarded") : null,
    tab.frozen ? t("flagFrozen") : null
  ].filter((flag): flag is string => flag !== null);

  return flags.length > 0 ? (
    <span className="tb-flags">
      {flags.map((flag) => (
        <span key={flag} className="tag">
          {flag}
        </span>
      ))}
    </span>
  ) : null;
}

const RELATION_KEYS = { "same-origin": "sameOrigin", "same-site": "sameSite" } as const;

/**
 * Tabs (R4): the other tabs of the recorded site — which were open at the playhead (with their
 * relation, address, title and state) and when tabs opened, navigated or closed.
 */
export function TabsPanel() {
  const controller = useController();
  const i18n = useI18n();
  const t = useFeatureI18n(tabsMessages);
  const archive = usePlayerState((state) => state.archive);
  const locale = usePlayerState((state) => state.locale);
  const selectedId = usePlayerState((state) =>
    state.selection?.kind === "event" ? state.selection.id : null
  );
  const nowMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / NOW_BUCKET_MS) * NOW_BUCKET_MS
      : state.playheadMono
  );
  const log = useMemo(() => (archive ? buildLog(archive) : []), [archive]);
  const logRef = useRef<HTMLDivElement>(null);
  const selectedIndex = selectedId ? log.findIndex((row) => row.eventId === selectedId) : -1;
  const selectedRow = selectedIndex >= 0 ? log[selectedIndex] : undefined;
  const openTabs = useMemo(
    () => (archive ? getRelatedTabsAt(archive.model.tabsContext, nowMono) : []),
    [archive, nowMono]
  );

  // Keep the selected change in view (keyboard stepping, or a selection made elsewhere).
  useEffect(() => {
    const option = selectedRow ? document.getElementById(optionId(selectedRow)) : null;

    if (option && logRef.current?.contains(option) && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [selectedRow]);

  if (!archive) {
    return null;
  }

  const { summary } = archive.model.tabsContext;
  const offset = (mono: number) => formatOffset(mono - archive.model.minMono, locale);
  const select = (row: TabsLogRow): void => {
    const event = archive.model.eventById.get(row.eventId);

    if (event) {
      controller.selectEvent(event);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys typed in a control inside the list, and Ctrl/Alt/Meta combinations, are not ours.
    if (!isOwnListKey(event)) {
      return;
    }

    const index =
      event.key === "Enter"
        ? selectedIndex >= 0
          ? selectedIndex
          : null
        : nextListIndex(
            event.key,
            selectedIndex,
            log.length,
            pageRowsOf(event.currentTarget, TABS_ROW_HEIGHT)
          );
    const row = index === null ? undefined : log[index];

    if (row) {
      event.preventDefault();
      select(row);
    }
  };

  if (log.length === 0) {
    return (
      <p className="list-empty" data-testid="tabs-empty">
        {t("noTabs")}
      </p>
    );
  }

  return (
    <div className="tb" data-testid="tabs-panel">
      <p className="tb-summary" data-testid="tabs-summary">
        {[
          summary.site ? t("site", { site: summary.site }) : null,
          t("distinct", { count: i18n.formatNumber(summary.distinctTabs) }),
          t("atStart", { count: i18n.formatNumber(summary.openAtStart) }),
          t("maxConcurrent", { count: i18n.formatNumber(summary.maxConcurrent) }),
          summary.level === "metadata" ? t("metadataOnly") : null
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <section aria-labelledby="tb-open">
        <h3 id="tb-open" className="tb-head">
          {t("openAt", { time: offset(nowMono), count: i18n.formatNumber(openTabs.length) })}
        </h3>
        {openTabs.length === 0 ? (
          <p className="tb-none">{t("noneOpen")}</p>
        ) : (
          <ul className="tb-open" data-testid="tabs-open">
            {openTabs.map((tab) => (
              <li key={tab.tabId} className="tb-card" data-testid="tabs-open-tab">
                <span className={`rel rel-${tab.relation}`}>{t(RELATION_KEYS[tab.relation])}</span>
                <span className="tb-text">
                  <span className="tb-title">{tab.title || t("untitled")}</span>
                  <TabWhere tab={tab} />
                </span>
                <TabFlags tab={tab} t={t} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="tb-log">
        <h3 id="tb-log" className="tb-head">
          {t("changes")}
        </h3>
        <div
          ref={logRef}
          role="listbox"
          tabIndex={0}
          aria-labelledby="tb-log"
          aria-activedescendant={selectedRow ? optionId(selectedRow) : undefined}
          onKeyDown={handleKeyDown}
          className="tb-log"
          data-testid="tabs-log"
        >
          {log.map((row) => (
            <div
              key={row.eventId}
              id={optionId(row)}
              role="option"
              aria-selected={row.eventId === selectedId}
              className={[
                "tb-row",
                row.mono > nowMono ? "future" : "",
                row.eventId === selectedId ? "cur" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => select(row)}
              data-testid="tabs-change"
              data-kind={row.label}
            >
              <time>{offset(row.mono)}</time>
              <span className={`chg chg-${row.label}`}>{labelText(row, t)}</span>
              {row.tab ? (
                <span className="tb-text">
                  <span className="tb-title">{row.tab.title || t("untitled")}</span>
                  <TabWhere tab={row.tab} />
                </span>
              ) : (
                <span className="tb-text muted">{t("allTabs")}</span>
              )}
              <span className="mono count">
                {t("openCount", { count: i18n.formatNumber(row.openCount) })}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default TabsPanel;
