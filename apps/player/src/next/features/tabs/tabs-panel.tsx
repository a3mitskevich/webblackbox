import "./tabs.css";

import { getRelatedTabsAt } from "@webblackbox/player-sdk";
import type { RelatedTabInfo } from "@webblackbox/protocol";
import { useMemo } from "react";

import { formatOffset } from "../../../core/format.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { tabsMessages, type TabsTranslate } from "./messages.js";

const NOW_BUCKET_MS = 250;

/** One row of the tabs log: a snapshot of all other tabs, or one tab's change. */
type TabsLogRow = {
  eventId: string;
  mono: number;
  kind: "snapshot" | "change";
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
  const openTabs = useMemo(
    () => (archive ? getRelatedTabsAt(archive.model.tabsContext, nowMono) : []),
    [archive, nowMono]
  );

  if (!archive) {
    return null;
  }

  const { summary } = archive.model.tabsContext;
  const offset = (mono: number) => formatOffset(mono - archive.model.minMono, locale);

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
        <div role="listbox" aria-labelledby="tb-log" className="tb-log" data-testid="tabs-log">
          {log.map((row) => (
            <div
              key={row.eventId}
              role="option"
              aria-selected={row.eventId === selectedId}
              className={[
                "tb-row",
                row.mono > nowMono ? "future" : "",
                row.eventId === selectedId ? "cur" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                const event = archive.model.eventById.get(row.eventId);

                if (event) {
                  controller.selectEvent(event);
                }
              }}
              data-testid="tabs-change"
              data-kind={row.label}
            >
              <time>{offset(row.mono)}</time>
              <span className={`chg chg-${row.label}`}>
                {row.kind === "snapshot" ? t("snapshot", { reason: row.label }) : row.label}
              </span>
              {row.tab ? (
                <span className="tb-text">
                  <span className="tb-title">{row.tab.title || t("untitled")}</span>
                  <TabWhere tab={row.tab} />
                </span>
              ) : (
                <span className="tb-text muted">{t("allTabs")}</span>
              )}
              <span className="mono count">{t("openCount", { count: row.openCount })}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default TabsPanel;
