import { useCallback, type KeyboardEvent } from "react";

import type { PlayerLocale } from "../../../lib/i18n.js";
import { describeRequestName, resolveNetworkInitiator } from "../../../lib/network-labels.js";
import { formatNetworkSize } from "../../../lib/network-size.js";
import {
  describeNetworkStatusPlain,
  resolveNetworkTypeLabel,
  type NetworkSortKey
} from "../../../lib/network-view.js";
import { Hint } from "../../components/hint.js";
import { Icon } from "../../components/icon.js";
import { VirtualList } from "../../components/virtual-list.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { notCapturedSummary } from "./availability.js";
import { networkMessages, type NetworkTranslator } from "./messages.js";
import {
  followIndex,
  isRowCut,
  rowUrl,
  selectionOfRow,
  type NetworkModel,
  type NetworkRow
} from "./rows.js";
import { networkSlice } from "./slice.js";
import { useNowMono } from "./use-network.js";

/** DevTools density (PROPOSAL §10, borrowed from Bench): one line per request. */
export const NETWORK_ROW_HEIGHT = 24;
const SLOW_REQUEST_MS = 1_000;

type Column = { key: NetworkSortKey; className: string };

const COLUMNS: readonly Column[] = [
  { key: "status", className: "c-status" },
  { key: "method", className: "c-method" },
  { key: "name", className: "c-name" },
  { key: "type", className: "c-type" },
  { key: "initiator", className: "c-initiator" },
  { key: "size", className: "c-size" },
  { key: "time", className: "c-time" },
  { key: "start", className: "c-wf" }
];

type Tone = "ok" | "bad" | "warn" | "ws" | "muted";

export function statusTone(row: NetworkRow): Tone {
  if (row.kind === "socket") {
    return "ws";
  }

  const { status, failed } = row.entry;

  if (failed || (typeof status === "number" && status >= 400)) {
    return "bad";
  }

  if (typeof status !== "number") {
    return "muted";
  }

  return status >= 300 ? "warn" : "ok";
}

function rowDomId(row: NetworkRow): string {
  return `net-${row.id.replace(/[^\w-]/g, "_")}`;
}

type RowCellsProps = {
  row: NetworkRow;
  model: NetworkModel;
  locale: PlayerLocale;
  t: NetworkTranslator;
  formatBytes: (bytes: number) => string;
  formatDuration: (ms: number) => string;
};

function RowCells({ row, model, locale, t, formatBytes, formatDuration }: RowCellsProps) {
  const name = describeRequestName(rowUrl(row));
  const tone = statusTone(row);
  const left = model.durationMono > 0 ? (row.startMono - model.minMono) / model.durationMono : 0;
  const width = model.durationMono > 0 ? row.durationMs / model.durationMono : 0;
  const notCaptured = row.kind === "http" ? notCapturedSummary(row.entry, t, formatBytes) : null;
  const cutLabel = isRowCut(row)
    ? row.kind === "socket"
      ? t("markerFramesCut", { count: row.stream.truncated })
      : t("markerCut")
    : null;

  return (
    <>
      <span role="gridcell" className={`c-status st ${tone}`}>
        {row.kind === "socket" ? "101" : describeNetworkStatusPlain(row.entry, locale)}
      </span>
      <span role="gridcell" className="c-method mono">
        {row.kind === "http" ? row.entry.method.toUpperCase() : "GET"}
      </span>
      <span role="gridcell" className="c-name">
        {row.kind === "socket" ? <Icon name="ws" className="ic ws-glyph" /> : null}
        <span className="path mono">{name.name}</span>
        <span className="host">{name.host}</span>
        {notCaptured ? (
          <Hint label={notCaptured}>
            <span
              className="flag-nc"
              role="img"
              aria-label={notCaptured}
              data-testid="row-not-captured"
            >
              !
            </span>
          </Hint>
        ) : null}
        {cutLabel ? (
          <Hint label={cutLabel}>
            <span className="trunc" role="img" aria-label={cutLabel} data-testid="row-cut">
              cut
            </span>
          </Hint>
        ) : null}
      </span>
      <span role="gridcell" className="c-type">
        {row.kind === "socket"
          ? t(row.stream.protocol === "ws" ? "socketType" : "sseType")
          : resolveNetworkTypeLabel(row.entry.mimeType, locale)}
      </span>
      <span role="gridcell" className="c-initiator mono">
        {row.kind === "http" && row.entry.actionId
          ? resolveNetworkInitiator(row.entry, locale)
          : ""}
      </span>
      <span role="gridcell" className="c-size mono">
        {row.kind === "http"
          ? formatNetworkSize(row.entry, locale)
          : formatBytes(row.stream.sentBytes + row.stream.receivedBytes)}
      </span>
      <span
        role="gridcell"
        className={row.durationMs >= SLOW_REQUEST_MS ? "c-time mono slow" : "c-time mono"}
      >
        {formatDuration(row.durationMs)}
      </span>
      <span role="gridcell" className="c-wf" aria-hidden="true">
        <span className="wf">
          <i
            className={tone === "muted" ? "" : tone}
            style={{
              left: `${Math.min(100, Math.max(0, left * 100))}%`,
              width: `${Math.max(0.6, width * 100)}%`
            }}
          />
        </span>
      </span>
    </>
  );
}

/** The playhead across the waterfall column (one element, not one per row). */
function WaterfallPlayhead({ model }: { model: NetworkModel }) {
  const nowMono = useNowMono();
  const ratio =
    model.durationMono > 0
      ? Math.min(1, Math.max(0, (nowMono - model.minMono) / model.durationMono))
      : 0;

  return (
    <div className="net-grid net-overlay" aria-hidden="true">
      <span className="c-wf">
        <span className="wf-ph" style={{ left: `${ratio * 100}%` }} />
      </span>
    </div>
  );
}

type NetworkTableProps = {
  model: NetworkModel;
  rows: NetworkRow[];
  selected: NetworkRow | null;
};

/**
 * The Network table: one dense row per request or socket, sortable columns, the future dimmed,
 * the waterfall drawn on the session span with the playhead across it. Rows are virtualized;
 * ↑ / ↓ move the selection while the table has focus.
 */
export function NetworkTable({ model, rows, selected }: NetworkTableProps) {
  const controller = useController();
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const follow = usePlayerState((state) => state.follow);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const sort = useFeatureSlice(networkSlice, (slice) => slice.sort);
  const updateSlice = useFeatureSliceUpdate(networkSlice);
  const nowMono = useNowMono();
  const selectedIndex = selected ? rows.indexOf(selected) : -1;
  const scrollTarget = isPlaying && follow ? followIndex(rows, nowMono) : selectedIndex;

  const formatDuration = useCallback(
    (ms: number) =>
      ms >= SLOW_REQUEST_MS
        ? i18n.formatSeconds(ms)
        : i18n.formatMilliseconds(ms, { fractionDigits: 0 }),
    [i18n]
  );

  const open = useCallback(
    (row: NetworkRow) => {
      const selection = selectionOfRow(row);

      if (selection) {
        controller.select(selection);
        controller.openDetails();
      }
    },
    [controller]
  );

  const sortBy = (key: NetworkSortKey): void =>
    updateSlice((slice) => ({
      ...slice,
      sort: {
        key,
        direction: slice.sort.key === key && slice.sort.direction === "asc" ? "desc" : "asc"
      }
    }));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = rows[selectedIndex < 0 ? 0 : selectedIndex + step];

    if (next) {
      open(next);
    }
  };

  return (
    <div
      className="net-table"
      role="grid"
      aria-label={t("tableLabel")}
      aria-rowcount={rows.length + 1}
      data-testid="network-table"
    >
      <div className="net-grid net-head" role="row" aria-rowindex={1}>
        {COLUMNS.map((column) => (
          <span
            key={column.key}
            role="columnheader"
            className={column.className}
            aria-sort={
              sort.key === column.key
                ? sort.direction === "asc"
                  ? "ascending"
                  : "descending"
                : undefined
            }
          >
            <button
              type="button"
              onClick={() => sortBy(column.key)}
              data-testid={`sort-${column.key}`}
            >
              {t(`col_${column.key}`)}
              {sort.key === column.key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
            </button>
          </span>
        ))}
      </div>
      <VirtualList
        role="rowgroup"
        tabIndex={0}
        aria-activedescendant={selected && selectedIndex >= 0 ? rowDomId(selected) : undefined}
        className="net-body"
        itemCount={rows.length}
        rowHeight={NETWORK_ROW_HEIGHT}
        scrollToIndex={scrollTarget}
        onKeyDown={handleKeyDown}
        overlay={<WaterfallPlayhead model={model} />}
        testId="network-rows"
        renderRow={(index) => {
          const row = rows[index];

          if (!row) {
            return null;
          }

          const isSelected = row === selected;
          const isFuture = row.startMono > nowMono;
          const className = ["net-grid net-row", isSelected ? "sel" : "", isFuture ? "future" : ""]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={row.id}
              id={rowDomId(row)}
              role="row"
              aria-rowindex={index + 2}
              aria-selected={isSelected}
              className={className}
              onClick={() => open(row)}
              data-testid="request-row"
              data-row-id={row.id}
              data-kind={row.kind}
              data-future={isFuture}
            >
              <RowCells
                row={row}
                model={model}
                locale={locale}
                t={t}
                formatBytes={i18n.formatByteSize}
                formatDuration={formatDuration}
              />
            </div>
          );
        }}
      />
    </div>
  );
}
