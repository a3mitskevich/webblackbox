import { useId, type KeyboardEvent } from "react";

import { RAIL_TABS, type RailTab } from "../../core/url-hash.js";
import type { NextMessageKey } from "../../lib/i18n.js";
import { selectActivityEvents } from "../controller.js";
import { useController, useI18n, usePlayerState } from "../context.js";
import type { LoadedArchive } from "../state.js";
import { EventList } from "./event-list.js";
import { Icon } from "./icon.js";

const TAB_LABEL_KEYS: Record<RailTab, NextMessageKey> = {
  activity: "tabActivity",
  network: "tabNetwork",
  console: "tabConsole",
  realtime: "tabRealtime",
  storage: "tabStorage",
  tabs: "tabTabs",
  perf: "tabPerf"
};

function countFor(tab: RailTab, archive: LoadedArchive, query: string): number {
  const { model, view } = archive;

  switch (tab) {
    case "activity":
      return selectActivityEvents(archive, query).length;
    case "network":
      return model.waterfall.length;
    case "console":
      return model.consoleSignals.length;
    case "realtime":
      return model.realtime.length;
    case "storage":
      return model.storage.length;
    case "tabs":
      return view.meta.otherTabs;
    case "perf":
      return model.perf.length;
  }
}

function DetailsPanel() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const selection = usePlayerState((state) => state.selection);
  const open = usePlayerState((state) => state.detailsOpen);
  const titleId = useId();

  if (!open || !archive || !selection) {
    return null;
  }

  const payload =
    selection.kind === "event"
      ? archive.model.eventById.get(selection.id)
      : selection.kind === "request"
        ? archive.model.waterfallByReqId.get(selection.id)
        : archive.model.actionTimeline.find((action) => action.actId === selection.id);

  return (
    <section className="details" aria-labelledby={titleId} data-testid="details-panel">
      <header className="details-head">
        <h2 id={titleId}>{i18n.tn("eventDetails")}</h2>
        <button
          type="button"
          className="btn icon-only small"
          aria-label={i18n.tn("closeDetails")}
          onClick={() => controller.close()}
        >
          <Icon name="close" />
        </button>
      </header>
      <pre className="code" data-testid="details-json">
        {payload ? JSON.stringify(payload, null, 2) : i18n.tn("detailsEmpty")}
      </pre>
    </section>
  );
}

function ComingLater({ tab }: { tab: RailTab }) {
  const i18n = useI18n();

  return (
    <div className="coming" data-testid={`panel-placeholder-${tab}`}>
      <p>{i18n.tn("comingLater", { panel: i18n.tn(TAB_LABEL_KEYS[tab]) })}</p>
      <p className="muted">{i18n.tn("comingLaterHint")}</p>
    </div>
  );
}

export function Rail() {
  const controller = useController();
  const i18n = useI18n();
  const archive = usePlayerState((state) => state.archive);
  const tab = usePlayerState((state) => state.tab);
  const query = usePlayerState((state) => state.query);
  const baseId = useId();

  if (!archive) {
    return null;
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const index = RAIL_TABS.indexOf(tab);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? RAIL_TABS.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + RAIL_TABS.length) % RAIL_TABS.length;
    const next = RAIL_TABS[nextIndex] ?? "activity";
    controller.setTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  return (
    <aside className="rail" aria-label={i18n.tn("railLabel")} data-testid="rail">
      <div
        className="rail-tabs"
        role="tablist"
        aria-label={i18n.tn("railLabel")}
        onKeyDown={moveFocus}
      >
        {RAIL_TABS.map((option) => {
          const count = countFor(option, archive, query);
          const isConsoleErrors = option === "console" && count > 0;

          return (
            <button
              key={option}
              id={`${baseId}-tab-${option}`}
              type="button"
              role="tab"
              className="rail-tab"
              aria-selected={option === tab}
              aria-controls={`${baseId}-panel`}
              tabIndex={option === tab ? 0 : -1}
              onClick={() => controller.setTab(option)}
              data-testid={`tab-${option}`}
            >
              {i18n.tn(TAB_LABEL_KEYS[option])}{" "}
              <span className={isConsoleErrors ? "c bad" : "c"}>{i18n.formatNumber(count)}</span>
            </button>
          );
        })}
      </div>
      <div
        id={`${baseId}-panel`}
        className="rail-panel"
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${tab}`}
        data-testid={`panel-${tab}`}
      >
        {tab === "activity" ? (
          <>
            <div className="rail-tools">
              <label className="field">
                <Icon name="filter" />
                <span className="visually-hidden">{i18n.tn("filterEvents")}</span>
                <input
                  type="search"
                  value={query}
                  placeholder={i18n.tn("filterEvents")}
                  onChange={(event) => controller.setQuery(event.target.value)}
                  data-testid="activity-filter"
                />
              </label>
            </div>
            <EventList />
            <DetailsPanel />
          </>
        ) : (
          <ComingLater tab={tab} />
        )}
      </div>
    </aside>
  );
}
