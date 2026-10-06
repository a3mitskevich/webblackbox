import "./console.css";

import {
  observeElementRect,
  useVirtualizer,
  type Rect,
  type Virtualizer
} from "@tanstack/react-virtual";
import type { ConsoleLevel } from "@webblackbox/player-sdk";
import { CircleAlert, Dot, Info, Terminal, TriangleAlert } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode
} from "react";

import { formatClock, formatOffset } from "../../../core/format.js";
import { upperBoundByMono } from "../../../lib/range.js";
import { formatPrivacyViolationText } from "../../../lib/recording-profile-view.js";
import { Icon } from "../../components/icon.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import {
  buildConsoleView,
  describeLocation,
  type ConsoleRow,
  type ConsoleView
} from "./console-model.js";
import { consoleMessages, type ConsoleTranslate } from "./messages.js";
import { consoleSlice, type ConsoleSlice } from "./slice.js";
import { StackBlock } from "./stack-block.js";
import { getSymbolicationService, type SymbolicationService } from "./symbolication.js";

/** One-line rows, DevTools density (PROPOSAL §10: 21–24 px rows from Bench). */
export const CONSOLE_ROW_HEIGHT = 33;
/** First guess for an opened row before it is measured. */
const EXPANDED_ROW_ESTIMATE = 360;
const NOW_BUCKET_MS = 120;
const OVERSCAN = 8;
const FALLBACK_VIEWPORT_HEIGHT = 480;

const LEVEL_CHIPS: readonly {
  level: ConsoleLevel;
  key: "errors" | "warnings" | "info" | "logs";
}[] = [
  { level: "error", key: "errors" },
  { level: "warn", key: "warnings" },
  { level: "info", key: "info" },
  { level: "log", key: "logs" }
];

const ICON_PROPS = { size: 15, strokeWidth: 1.5, absoluteStrokeWidth: true, "aria-hidden": true };

function LevelGlyph({ level }: { level: ConsoleLevel }) {
  switch (level) {
    case "error":
      return <CircleAlert {...ICON_PROPS} />;
    case "warn":
      return <TriangleAlert {...ICON_PROPS} />;
    case "info":
      return <Info {...ICON_PROPS} />;
    case "debug":
      return <Terminal {...ICON_PROPS} />;
    default:
      return <Dot {...ICON_PROPS} />;
  }
}

function observeRectWithFallback(
  instance: Virtualizer<HTMLDivElement, Element>,
  onRect: (rect: Rect) => void
): void | (() => void) {
  return observeElementRect(instance, (rect) =>
    onRect(rect.height > 0 ? rect : { width: rect.width, height: FALLBACK_VIEWPORT_HEIGHT })
  );
}

type ToggleChipProps = {
  pressed: boolean;
  onToggle: () => void;
  testId: string;
  children: ReactNode;
};

function ToggleChip({ pressed, onToggle, testId, children }: ToggleChipProps) {
  return (
    <button
      type="button"
      className="fchip"
      aria-pressed={pressed}
      onClick={onToggle}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

type ConsoleFilters = Pick<ConsoleSlice, "levels" | "groupSimilar" | "hideThirdParty">;

function ConsoleTools({ view, slice }: { view: ConsoleView; slice: ConsoleFilters }) {
  const controller = useController();
  const i18n = useI18n();
  const t = useFeatureI18n(consoleMessages);
  const query = usePlayerState((state) => state.query);
  const update = useFeatureSliceUpdate(consoleSlice);

  const toggleLevel = (level: ConsoleLevel): void =>
    update((current) => ({
      ...current,
      levels: current.levels.includes(level)
        ? current.levels.filter((item) => item !== level)
        : [...current.levels, level]
    }));

  return (
    <div className="rail-tools console-tools" role="toolbar" aria-label={t("tools")}>
      <label className="field">
        <Icon name="filter" />
        <span className="visually-hidden">{t("filterMessages")}</span>
        <input
          type="search"
          value={query}
          placeholder={t("filterMessages")}
          onChange={(event) => controller.setQuery(event.target.value)}
          data-testid="console-filter"
        />
      </label>
      <div className="fchips">
        {LEVEL_CHIPS.map(({ level, key }) => (
          <ToggleChip
            key={level}
            pressed={slice.levels.includes(level)}
            onToggle={() => toggleLevel(level)}
            testId={`console-level-${level}`}
          >
            {t(key)} <span className="mono">{i18n.formatNumber(view.levelCounts[level])}</span>
          </ToggleChip>
        ))}
        <ToggleChip
          pressed={slice.groupSimilar}
          onToggle={() =>
            update((current) => ({ ...current, groupSimilar: !current.groupSimilar }))
          }
          testId="console-group-similar"
        >
          {t("groupSimilar")}
        </ToggleChip>
        <ToggleChip
          pressed={slice.hideThirdParty}
          onToggle={() =>
            update((current) => ({ ...current, hideThirdParty: !current.hideThirdParty }))
          }
          testId="console-hide-third-party"
        >
          {t("hideThirdParty")}
          {slice.hideThirdParty && view.hiddenThirdParty > 0 ? (
            <span className="mono" data-testid="console-hidden-count">
              {" "}
              {t("hiddenCount", { count: i18n.formatNumber(view.hiddenThirdParty) })}
            </span>
          ) : null}
        </ToggleChip>
      </div>
    </div>
  );
}

type ConsoleRowViewProps = {
  archive: LoadedArchive;
  row: ConsoleRow;
  service: SymbolicationService;
  locale: string;
  isSelected: boolean;
  isExpanded: boolean;
  isFuture: boolean;
  /** 1-based position among all rows (the list is virtualized). */
  position: number;
  rowCount: number;
  message: string;
  onActivate: (row: ConsoleRow) => void;
  t: ConsoleTranslate;
};

/** The location column: the symbolicated top frame once resolved, else the recorded one. */
function useTopLocation(
  service: SymbolicationService,
  row: ConsoleRow,
  archive: LoadedArchive
): string | null {
  const event = archive.model.eventById.get(row.entry.eventId);
  const { eventId } = row.entry;
  // Only this row's resolution: other rows resolving do not re-render it.
  const peek = useCallback(() => service.peek(eventId), [service, eventId]);
  const resolution = useSyncExternalStore(service.subscribe, peek, peek);

  useEffect(() => {
    // Also re-requests after the service evicted or reset its cache.
    if (event && row.entry.hasStack && !resolution) {
      service.request(event);
    }
  }, [service, event, row.entry.hasStack, resolution]);

  const mapped =
    resolution?.status === "done"
      ? resolution.frames.find((frame) => frame.status === "mapped")?.original
      : undefined;

  if (mapped) {
    return describeLocation(mapped.source, mapped.line);
  }

  const { location } = row.entry;
  return location ? describeLocation(location.url, location.line) : null;
}

const ConsoleRowView = memo(function ConsoleRowView({
  archive,
  row,
  service,
  locale,
  isSelected,
  isExpanded,
  isFuture,
  position,
  rowCount,
  message,
  onActivate,
  t
}: ConsoleRowViewProps) {
  const { entry } = row;
  const location = useTopLocation(service, row, archive);
  const event = archive.model.eventById.get(entry.eventId);
  const classes = [
    "cr",
    `cr-${entry.level}`,
    isSelected ? "cur" : "",
    isFuture ? "future" : "",
    entry.isThirdParty ? "tp" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={isExpanded ? "cr-wrap open" : "cr-wrap"}>
      <div
        role="option"
        id={`console-${entry.eventId}`}
        aria-selected={isSelected}
        aria-expanded={isExpanded}
        aria-setsize={rowCount}
        aria-posinset={position}
        className={classes}
        onClick={() => onActivate(row)}
        data-testid="console-row"
        data-event-id={entry.eventId}
        data-level={entry.level}
        data-future={isFuture}
      >
        <time>{formatOffset(entry.mono - archive.model.minMono, locale)}</time>
        <span className="gl" role="img" aria-label={t(`level_${entry.level}`)}>
          <LevelGlyph level={entry.level} />
        </span>
        <span className="msg">{message}</span>
        {row.count > 1 ? (
          <span className="badge" data-testid="console-row-count">
            ×{row.count}
          </span>
        ) : null}
        {entry.reqId ? <span className="req mono">{entry.reqId}</span> : null}
        {location ? (
          <span className="where" title={entry.location?.url}>
            {location}
          </span>
        ) : null}
      </div>
      {isExpanded && event ? (
        <StackBlock archive={archive} row={row} event={event} message={message} />
      ) : null}
    </div>
  );
});

function NowLabel() {
  const t = useFeatureI18n(consoleMessages);
  const locale = usePlayerState((state) => state.locale);
  const offset = usePlayerState((state) =>
    state.archive ? state.playheadMono - state.archive.model.minMono : 0
  );

  return (
    <span className="nowline-label">
      {formatClock(offset, locale)} · {t("now")}
    </span>
  );
}

type ConsoleListProps = {
  archive: LoadedArchive;
  rows: ConsoleRow[];
  expandedId: string | null;
};

function ConsoleList({ archive, rows, expandedId }: ConsoleListProps) {
  const controller = useController();
  const i18n = useI18n();
  const t = useFeatureI18n(consoleMessages);
  const locale = usePlayerState((state) => state.locale);
  const follow = usePlayerState((state) => state.follow);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const update = useFeatureSliceUpdate(consoleSlice);
  const selectedEventId = usePlayerState((state) =>
    state.selection?.kind === "event" ? state.selection.id : null
  );
  const nowMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / NOW_BUCKET_MS) * NOW_BUCKET_MS
      : state.playheadMono
  );
  const service = getSymbolicationService(archive.player);
  const ref = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (index) =>
      rows[index]?.entry.eventId === expandedId ? EXPANDED_ROW_ESTIMATE : CONSOLE_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.entry.eventId ?? index,
    overscan: OVERSCAN,
    observeElementRect: observeRectWithFallback,
    useFlushSync: false
  });
  const nowIndex = upperBoundByMono(rows, nowMono, (row) => row.entry.mono);
  const rowIndexByEventId = useMemo(
    () =>
      new Map(
        rows.flatMap((row, index) => row.memberIds.map((id): [string, number] => [id, index]))
      ),
    [rows]
  );
  const selectedIndex = selectedEventId ? (rowIndexByEventId.get(selectedEventId) ?? -1) : -1;
  const scrollTarget = isPlaying && follow ? Math.max(0, nowIndex - 1) : selectedIndex;

  useEffect(() => {
    const element = ref.current;
    const item = scrollTarget >= 0 ? virtualizer.measurementsCache[scrollTarget] : undefined;

    if (!element || !item) {
      return;
    }

    if (item.start < element.scrollTop || item.end > element.scrollTop + element.clientHeight) {
      virtualizer.scrollToIndex(scrollTarget, { align: isPlaying ? "center" : "auto" });
    }
  }, [scrollTarget, isPlaying, virtualizer]);

  const messageOf = useCallback(
    (row: ConsoleRow): string => {
      if (!row.entry.privacyViolation) {
        return row.entry.message;
      }

      const event = archive.model.eventById.get(row.entry.eventId);
      return (
        (event && formatPrivacyViolationText(event, i18n.formatHiddenByProfile)) ??
        row.entry.message
      );
    },
    [archive, i18n]
  );

  const activate = useCallback(
    (row: ConsoleRow) => {
      const event = archive.model.eventById.get(row.entry.eventId);

      if (event) {
        controller.selectEvent(event);
      }

      update((slice) => ({
        ...slice,
        expandedId: slice.expandedId === row.entry.eventId ? null : row.entry.eventId
      }));
    },
    [archive, controller, update]
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys typed into the opened row's controls (buttons, symbol server field) stay theirs.
    if (event.target !== event.currentTarget) {
      return;
    }

    if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      const row = rows[selectedIndex];

      if (row) {
        activate(row);
      }

      return;
    }

    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    const next =
      rows[
        Math.min(rows.length - 1, Math.max(0, selectedIndex + (event.key === "ArrowDown" ? 1 : -1)))
      ];
    const target = next ? archive.model.eventById.get(next.entry.eventId) : undefined;

    if (target) {
      controller.selectEvent(target);
    }
  };

  const items = virtualizer.getVirtualItems();
  const offset = items[0]?.start ?? 0;
  const nowTop = virtualizer.measurementsCache[nowIndex]?.start ?? virtualizer.getTotalSize();

  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={0}
      aria-label={t("tabLabel")}
      aria-activedescendant={
        selectedIndex >= 0 ? `console-${rows[selectedIndex]?.entry.eventId}` : undefined
      }
      className="vlist console-list"
      onKeyDown={handleKeyDown}
      data-testid="console-list"
    >
      <div className="vlist-canvas" style={{ height: virtualizer.getTotalSize() }}>
        <div className="vlist-window" style={{ transform: `translateY(${offset}px)` }}>
          {items.map((item) => {
            const row = rows[item.index];

            return row ? (
              <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}>
                <ConsoleRowView
                  archive={archive}
                  row={row}
                  service={service}
                  locale={locale}
                  isSelected={item.index === selectedIndex}
                  isExpanded={row.entry.eventId === expandedId}
                  isFuture={item.index >= nowIndex}
                  position={item.index + 1}
                  rowCount={rows.length}
                  message={messageOf(row)}
                  onActivate={activate}
                  t={t}
                />
              </div>
            ) : null;
          })}
        </div>
        <div
          className="nowline"
          style={{ top: nowTop }}
          aria-hidden="true"
          data-testid="console-now-line"
        >
          <NowLabel />
        </div>
      </div>
    </div>
  );
}

const selectFilters = (slice: ConsoleSlice): ConsoleFilters => ({
  levels: slice.levels,
  groupSimilar: slice.groupSimilar,
  hideThirdParty: slice.hideThirdParty
});
const sameFilters = (left: ConsoleFilters, right: ConsoleFilters): boolean =>
  left.levels === right.levels &&
  left.groupSimilar === right.groupSimilar &&
  left.hideThirdParty === right.hideThirdParty;
const selectExpandedId = (slice: ConsoleSlice): string | null => slice.expandedId;

/**
 * The Console rail tab: console output and errors with their level, the request they are about
 * and the script position; a row opens in place with its symbolicated stack (Replay mockup).
 */
export function ConsolePanel() {
  const t = useFeatureI18n(consoleMessages);
  const archive = usePlayerState((state) => state.archive);
  const query = usePlayerState((state) => state.query);
  const range = usePlayerState((state) => state.range);
  // Opening a row or switching the stack mode must not rebuild the list.
  const slice = useFeatureSlice(consoleSlice, selectFilters, sameFilters);
  const expandedId = useFeatureSlice(consoleSlice, selectExpandedId);
  const view = useMemo(
    () =>
      archive
        ? buildConsoleView(archive, slice, query, range)
        : {
            rows: [],
            levelCounts: { error: 0, warn: 0, info: 0, log: 0, debug: 0 },
            hiddenThirdParty: 0,
            total: 0
          },
    [archive, slice, query, range]
  );

  if (!archive) {
    return null;
  }

  return (
    <>
      <ConsoleTools view={view} slice={slice} />
      {view.rows.length > 0 ? (
        <ConsoleList archive={archive} rows={view.rows} expandedId={expandedId} />
      ) : (
        <p className="list-empty" data-testid="console-empty">
          {view.total === 0 ? t("noConsole") : t("noMatches")}
        </p>
      )}
    </>
  );
}

export default ConsolePanel;
