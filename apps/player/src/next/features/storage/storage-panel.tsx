import "./storage.css";

import type {
  CookieItem,
  IdbDatabaseItem,
  StorageArea,
  StorageAreaState,
  StorageChange,
  StorageItem
} from "@webblackbox/player-sdk";
import { useMemo, type ReactNode } from "react";

import { formatOffset } from "../../../core/format.js";
import { upperBoundByMono } from "../../../lib/range.js";
import { Icon } from "../../components/icon.js";
import { ListDetailsSplit } from "../../components/split-layout.js";
import { VirtualList } from "../../components/virtual-list.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { storageMessages, type StorageTranslate } from "./messages.js";
import { storageSlice, type StorageView } from "./slice.js";
import {
  filterStorageChanges,
  matchesQuery,
  selectStorageData,
  selectStorageStateAt
} from "./storage-model.js";
import { ValueDiff } from "./value-diff.js";

const LOG_ROW_HEIGHT = 32;
/** While playing, the rebuilt state follows the playhead in steps of this size. */
const STATE_BUCKET_MS = 250;
/** A key written this recently before the playhead is highlighted. */
const RECENT_WRITE_MS = 2_000;
const VALUE_PREVIEW_CHARS = 160;

const AREAS: readonly StorageArea[] = ["local", "session", "cookie", "idb"];
const AREA_KEYS = {
  local: "areaLocal",
  session: "areaSession",
  cookie: "areaCookie",
  idb: "areaIdb",
  cache: "areaCache",
  sw: "areaSw"
} as const;

function preview(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }

  return value.length > VALUE_PREVIEW_CHARS ? `${value.slice(0, VALUE_PREVIEW_CHARS)}…` : value;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testIdPrefix
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  testIdPrefix: string;
}) {
  return (
    <div className="seg seg-small" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          data-testid={`${testIdPrefix}-${option.value}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CoverageNote({
  state,
  area,
  archive,
  t
}: {
  state: StorageAreaState<unknown>;
  area: StorageArea;
  archive: LoadedArchive;
  t: StorageTranslate;
}) {
  const locale = usePlayerState((value) => value.locale);
  const notes: string[] = [];

  if (state.coverage === "names") {
    notes.push(t("coverageNames"));
  } else if (state.coverage === "counts") {
    notes.push(t("coverageCounts", { count: state.reportedCount ?? 0 }));
  } else if (state.coverage === "none") {
    notes.push(t("coverageNone"));
  }

  if (state.snapshotMono !== undefined) {
    notes.push(
      t("fromSnapshot", { time: formatOffset(state.snapshotMono - archive.model.minMono, locale) })
    );
  } else if (area === "session" || area === "local") {
    notes.push(t("noSnapshot"));
  }

  if (state.truncated) {
    notes.push(t("truncated"));
  }

  return notes.length > 0 ? (
    <p className="st-note" data-testid="storage-coverage" data-coverage={state.coverage}>
      {notes.join(" · ")}
    </p>
  ) : null;
}

function KeyValueTable({
  items,
  archive,
  nowMono,
  query
}: {
  items: readonly StorageItem[];
  archive: LoadedArchive;
  nowMono: number;
  query: string;
}) {
  const controller = useController();
  const t = useFeatureI18n(storageMessages);
  const locale = usePlayerState((state) => state.locale);
  const rows = items.filter((item) => matchesQuery(query, item.key, item.value));

  if (rows.length === 0) {
    return <p className="list-empty">{t("noKeys")}</p>;
  }

  return (
    <table className="st-table" data-testid="storage-items">
      <thead>
        <tr>
          <th>{t("key")}</th>
          <th>{t("value")}</th>
          <th>{t("written")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => {
          const isRecent = nowMono - item.updatedMono <= RECENT_WRITE_MS;

          return (
            <tr
              key={item.key}
              className={isRecent ? "recent" : undefined}
              data-testid="storage-item"
            >
              <td className="mono key" title={item.key}>
                {item.key}
              </td>
              <td className="mono val" title={item.value}>
                {item.value !== undefined
                  ? preview(item.value)
                  : item.valueLength !== undefined
                    ? t("lengthOnly", { length: item.valueLength })
                    : "—"}
                {item.valueTruncated ? <span className="tag">{t("cut")}</span> : null}
              </td>
              <td>
                <button
                  type="button"
                  className="linklike mono"
                  onClick={() => {
                    const event = archive.model.eventById.get(item.updatedEventId);

                    if (event) {
                      controller.selectEvent(event);
                    }
                  }}
                >
                  {formatOffset(item.updatedMono - archive.model.minMono, locale)}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CookieTable({ items, query }: { items: readonly CookieItem[]; query: string }) {
  const t = useFeatureI18n(storageMessages);
  const rows = items.filter((item) => matchesQuery(query, item.name, item.value, item.domain));

  if (rows.length === 0) {
    return <p className="list-empty">{t("noKeys")}</p>;
  }

  return (
    <table className="st-table" data-testid="storage-cookies">
      <thead>
        <tr>
          <th>{t("name")}</th>
          <th>{t("value")}</th>
          <th>{t("flags")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((cookie, index) => (
          <tr
            key={`${cookie.name}-${cookie.domain ?? ""}-${cookie.path ?? ""}-${index}`}
            data-testid="storage-cookie"
          >
            <td className="mono key" title={[cookie.domain, cookie.path].filter(Boolean).join(" ")}>
              {cookie.name}
            </td>
            <td className="mono val" title={cookie.value}>
              {cookie.value !== undefined ? preview(cookie.value) : "—"}
              {cookie.valueTruncated ? <span className="tag">{t("cut")}</span> : null}
            </td>
            <td className="flags">
              {cookie.httpOnly ? <span className="tag">HttpOnly</span> : null}
              {cookie.secure ? <span className="tag">Secure</span> : null}
              {cookie.sameSite ? <span className="tag">SameSite={cookie.sameSite}</span> : null}
              {cookie.domain ? (
                <span className="muted mono">
                  {cookie.domain}
                  {cookie.path ?? ""}
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IdbTree({ items, query }: { items: readonly IdbDatabaseItem[]; query: string }) {
  const t = useFeatureI18n(storageMessages);

  if (items.length === 0) {
    return <p className="list-empty">{t("noDatabases")}</p>;
  }

  return (
    <div className="st-idb" data-testid="storage-idb">
      {items.map((database) => (
        <section key={database.name} className="st-db">
          <h4 className="mono">
            {database.name}
            {database.version !== undefined ? (
              <span className="muted"> v{database.version}</span>
            ) : null}
          </h4>
          {database.error ? (
            <p className="st-note bad">{t("dbError", { error: database.error })}</p>
          ) : null}
          {database.stores.length === 0 && !database.error ? (
            <p className="st-note">{t("namesOnlyDb")}</p>
          ) : null}
          {database.stores.map((store) => (
            <div key={store.name} className="st-store">
              <p className="mono store-name">
                {store.name} <span className="muted">{t("records", { count: store.count })}</span>
              </p>
              <table className="st-table">
                <tbody>
                  {store.records
                    .filter((record) => matchesQuery(query, record.key, record.value))
                    .map((record) => (
                      <tr key={record.key} data-testid="storage-idb-record">
                        <td className="mono key">{record.key}</td>
                        <td className="mono val" title={record.value}>
                          {preview(record.value)}
                          {record.valueTruncated ? <span className="tag">{t("cut")}</span> : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {store.truncated ? <p className="st-note">{t("storeTruncated")}</p> : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function StateView({ archive, area }: { archive: LoadedArchive; area: StorageArea }) {
  const t = useFeatureI18n(storageMessages);
  const query = usePlayerState((state) => state.query);
  const nowMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / STATE_BUCKET_MS) * STATE_BUCKET_MS
      : state.playheadMono
  );
  const state = useMemo(() => selectStorageStateAt(archive, nowMono), [archive, nowMono]);
  const areaState = state[area];

  return (
    <div className="st-state" data-testid="storage-state" data-area={area}>
      <CoverageNote state={areaState} area={area} archive={archive} t={t} />
      {area === "cookie" ? (
        <CookieTable items={state.cookie.items} query={query} />
      ) : area === "idb" ? (
        <IdbTree items={state.idb.items} query={query} />
      ) : (
        <KeyValueTable
          items={state[area].items}
          archive={archive}
          nowMono={nowMono}
          query={query}
        />
      )}
    </div>
  );
}

function ChangeDetails({ change, archive }: { change: StorageChange; archive: LoadedArchive }) {
  const controller = useController();
  const t = useFeatureI18n(storageMessages);
  const locale = usePlayerState((state) => state.locale);

  return (
    <section
      className="details"
      aria-label={t("changeDetails")}
      data-testid="storage-change-details"
    >
      <header className="details-head">
        <h2>
          {t(AREA_KEYS[change.area])} · <span className="mono">{change.op}</span>
          {change.key ? <span className="mono"> {change.key}</span> : null}
        </h2>
        <button
          type="button"
          className="btn icon-only small"
          aria-label={t("closeDetails")}
          onClick={() => controller.clearSelection()}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="st-details-body">
        <p className="muted">
          {formatOffset(change.mono - archive.model.minMono, locale)}
          {change.redacted ? ` · ${t("redacted")}` : ""}
          {change.count !== undefined ? ` · ${t("items", { count: change.count })}` : ""}
          {change.reason ? ` · ${change.reason}` : ""}
        </p>
        {change.op === "setItem" ? (
          <ValueDiff before={change.previousValue} after={change.value} />
        ) : change.op === "removeItem" ? (
          <>
            <p className="muted">{t("removed")}</p>
            {typeof change.previousValue === "string" ? (
              <pre className="st-value del">{change.previousValue}</pre>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function LogView({ archive }: { archive: LoadedArchive }) {
  const controller = useController();
  const t = useFeatureI18n(storageMessages);
  const locale = usePlayerState((state) => state.locale);
  const query = usePlayerState((state) => state.query);
  const selectedId = usePlayerState((state) =>
    state.selection?.kind === "event" ? state.selection.id : null
  );
  const nowMono = usePlayerState((state) =>
    state.isPlaying ? Math.floor(state.playheadMono / 120) * 120 : state.playheadMono
  );
  const changes = useMemo(
    () => filterStorageChanges(selectStorageData(archive).changes, query),
    [archive, query]
  );
  const nowIndex = upperBoundByMono(changes, nowMono, (change) => change.mono);
  const selectedIndex = selectedId
    ? changes.findIndex((change) => change.eventId === selectedId)
    : -1;
  const selected = selectedIndex >= 0 ? changes[selectedIndex] : undefined;

  if (changes.length === 0) {
    return (
      <p className="list-empty" data-testid="storage-log-empty">
        {t("noChanges")}
      </p>
    );
  }

  const list = (
    <VirtualList
      role="listbox"
      tabIndex={0}
      aria-label={t("logLabel")}
      className="st-log"
      itemCount={changes.length}
      rowHeight={LOG_ROW_HEIGHT}
      scrollToIndex={selectedIndex >= 0 ? selectedIndex : null}
      testId="storage-log"
      overlay={
        <div className="nowline" style={{ top: nowIndex * LOG_ROW_HEIGHT }} aria-hidden="true" />
      }
      renderRow={(index) => {
        const change = changes[index];

        if (!change) {
          return null;
        }

        const isFuture = index >= nowIndex;

        return (
          <div
            key={change.eventId}
            role="option"
            aria-selected={change.eventId === selectedId}
            className={[
              "st-row",
              isFuture ? "future" : "",
              change.eventId === selectedId ? "cur" : ""
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => {
              const event = archive.model.eventById.get(change.eventId);

              if (event) {
                controller.selectEvent(event);
              }
            }}
            data-testid="storage-change"
            data-area={change.area}
            data-op={change.op}
          >
            <time>{formatOffset(change.mono - archive.model.minMono, locale)}</time>
            <span className={`area area-${change.area}`}>{t(AREA_KEYS[change.area])}</span>
            <span className="mono op">{change.op}</span>
            <span className="mono key">
              {change.key ??
                (change.count !== undefined ? t("items", { count: change.count }) : "")}
            </span>
            <span className="mono val">{preview(change.value)}</span>
          </div>
        );
      }}
    />
  );

  return (
    <ListDetailsSplit
      name="storage"
      list={list}
      details={selected ? <ChangeDetails change={selected} archive={archive} /> : null}
    />
  );
}

const selectWholeSlice = (slice: { view: StorageView; area: StorageArea }) => slice;

/**
 * Storage (R4): what localStorage, sessionStorage, cookies and IndexedDB held at the playhead
 * (rebuilt from snapshots and the writes after them), and the log of writes with old → new diffs.
 */
export function StoragePanel() {
  const controller = useController();
  const i18n = useI18n();
  const t = useFeatureI18n(storageMessages);
  const archive = usePlayerState((state) => state.archive);
  const query = usePlayerState((state) => state.query);
  const slice = useFeatureSlice(storageSlice, selectWholeSlice);
  const update = useFeatureSliceUpdate(storageSlice);
  const changeCount = archive ? selectStorageData(archive).changes.length : 0;

  if (!archive) {
    return null;
  }

  return (
    <>
      <div className="rail-tools st-tools">
        <Segmented
          value={slice.view}
          label={t("viewLabel")}
          testIdPrefix="storage-view"
          onChange={(view) => update((current) => ({ ...current, view }))}
          options={[
            { value: "state", label: t("viewState") },
            {
              value: "log",
              label: (
                <>
                  {t("viewLog")} <span className="mono">{i18n.formatNumber(changeCount)}</span>
                </>
              )
            }
          ]}
        />
        {slice.view === "state" ? (
          <Segmented
            value={slice.area}
            label={t("areaLabel")}
            testIdPrefix="storage-area"
            onChange={(area) => update((current) => ({ ...current, area }))}
            options={AREAS.map((area) => ({ value: area, label: t(AREA_KEYS[area]) }))}
          />
        ) : null}
        <label className="field">
          <Icon name="filter" />
          <span className="visually-hidden">{t("filterKeys")}</span>
          <input
            type="search"
            value={query}
            placeholder={t("filterKeys")}
            onChange={(event) => controller.setQuery(event.target.value)}
            data-testid="storage-filter"
          />
        </label>
      </div>
      {slice.view === "state" ? (
        <StateView archive={archive} area={slice.area} />
      ) : (
        <LogView archive={archive} />
      )}
    </>
  );
}

export default StoragePanel;
