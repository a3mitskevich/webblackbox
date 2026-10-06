import {
  observeElementRect,
  useVirtualizer,
  type Rect,
  type Virtualizer
} from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";

import { formatClock, formatOffset } from "../../../core/format.js";
import { upperBoundByMono } from "../../../lib/range.js";
import { Icon } from "../../components/icon.js";
import { useController, usePlayerState } from "../../context.js";
import { resolveSelectedEventId } from "../../controller.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import {
  describeContext,
  describeFeedItem,
  feedViewOf,
  type DescribeContext,
  type FeedEntry
} from "./feed-view.js";
import { feedMessages } from "./messages.js";
import { feedSlice, toggleExpanded, type FeedSlice } from "./slice.js";

/** First estimate of a row (two lines); rows are measured once rendered. */
const ROW_ESTIMATE = 48;
const OVERSCAN = 10;
/** While playing, "past / future" follows the playhead in steps of this size, not every frame. */
const NOW_BUCKET_MS = 120;
/** A list that is not laid out yet (hidden tab, jsdom) still renders a first window of rows. */
const FALLBACK_VIEWPORT_HEIGHT = 480;

type FeedRowProps = {
  entry: FeedEntry;
  index: number;
  context: DescribeContext;
  minMono: number;
  selected: boolean;
  future: boolean;
  measure: (node: Element | null) => void;
  start: number;
  onSelect: (eventId: string) => void;
  onToggle: (eventId: string) => void;
};

const FeedRow = memo(function FeedRow({
  entry,
  index,
  context,
  minMono,
  selected,
  future,
  measure,
  start,
  onSelect,
  onToggle
}: FeedRowProps) {
  const { item } = entry;
  const text = useMemo(() => describeFeedItem(item, context), [item, context]);
  const classes = [
    "fi",
    `tone-${text.tone}`,
    item.actId !== null ? "is-action" : "",
    item.parentActId !== null ? "child" : "",
    entry.nested ? "nested" : "",
    selected ? "cur" : "",
    future ? "future" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={measure}
      role="option"
      id={`evt-${item.eventId}`}
      aria-selected={selected}
      aria-expanded={entry.count > 1 ? entry.expanded : undefined}
      className={classes}
      style={{ transform: `translateY(${start}px)` }}
      onClick={() => onSelect(item.eventId)}
      data-index={index}
      data-testid="event-row"
      data-event-id={item.eventId}
      data-kind={item.kind}
      data-third-party={item.thirdParty}
      data-future={future}
    >
      <time>{formatOffset(item.mono - minMono, context.locale)}</time>
      <span className="gl">
        <Icon name={text.glyph} />
      </span>
      <div className="tt">
        <div className="t1">
          {text.code !== null ? <span className="code mono">{text.code}</span> : null}
          {entry.count > 1 ? (
            <button
              type="button"
              tabIndex={-1}
              className="rep"
              aria-label={
                entry.expanded
                  ? context.t("collapseRepeats")
                  : context.t("expandRepeats", { count: entry.count })
              }
              onClick={(event) => {
                event.stopPropagation();
                onToggle(item.eventId);
              }}
              data-testid="repeat-toggle"
            >
              {context.t("repeatCount", { count: entry.count })}
            </button>
          ) : null}
          {text.lead ? <span className="lead">{text.lead}</span> : null}
          {text.subject ? (
            <span className={text.subjectIsCode ? "subj mono" : "subj"}>{text.subject}</span>
          ) : null}
          {text.badge ? (
            <span className="cnt" data-testid="visit-badge">
              {text.badge}
            </span>
          ) : null}
        </div>
        {text.secondary ? <div className="t2">{text.secondary}</div> : null}
        {text.flag ? (
          <div className="flag" data-testid="problem-flag">
            <Icon name="flag" />
            {text.flag}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** "0:10.89 · now": the only part of the feed that follows the playhead on every frame. */
function NowLabel() {
  const t = useFeatureI18n(feedMessages);
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

const selectSlice = (slice: FeedSlice): FeedSlice => slice;

function observeRectWithFallback(
  instance: Virtualizer<HTMLDivElement, Element>,
  onRect: (rect: Rect) => void
): void | (() => void) {
  return observeElementRect(instance, (rect) =>
    onRect(rect.height > 0 ? rect : { width: rect.width, height: FALLBACK_VIEWPORT_HEIGHT })
  );
}

/**
 * The Activity feed (PROPOSAL §9 B): actions with their consequences under them, routes,
 * failures, sockets and console errors; repeats collapse into "×N" rows; the "now" line splits
 * the past from the dimmed future and, while playing with "Follow playhead", the list scrolls with
 * it. Rows have variable heights (flags, repeats), measured by TanStack Virtual.
 */
export function ActivityFeed() {
  const controller = useController();
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const query = usePlayerState((state) => state.query);
  const locale = usePlayerState((state) => state.locale);
  const follow = usePlayerState((state) => state.follow);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const slice = useFeatureSlice(feedSlice, selectSlice);
  const updateSlice = useFeatureSliceUpdate(feedSlice);
  const selectedEventId = usePlayerState((state) =>
    state.archive ? resolveSelectedEventId(state.archive, state.selection) : null
  );
  // Exact while paused; while playing the feed follows in NOW_BUCKET_MS steps.
  const nowMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / NOW_BUCKET_MS) * NOW_BUCKET_MS
      : state.playheadMono
  );
  const context = useMemo(
    () => (archive ? describeContext(archive, locale) : null),
    [archive, locale]
  );
  const view = useMemo(
    () =>
      archive
        ? feedViewOf(archive, {
            query,
            errorsOnly: slice.errorsOnly,
            hideThirdParty: slice.hideThirdParty,
            scope: slice.scope,
            expanded: slice.expanded,
            selectedEventId,
            locale
          })
        : null,
    [archive, query, slice, selectedEventId, locale]
  );
  const entries = useMemo(() => view?.entries ?? [], [view]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => entries[index]?.key ?? index,
    overscan: OVERSCAN,
    observeElementRect: observeRectWithFallback,
    // React 19 warns about flushSync inside lifecycle methods (LIBRARIES.md).
    useFlushSync: false
  });
  // Rows at or before the playhead are the past; the label shows the exact playhead.
  const nowIndex = upperBoundByMono(entries, nowMono, (entry) => entry.item.mono);
  const selectedIndex = selectedEventId
    ? entries.findIndex((entry) => entry.item.eventId === selectedEventId)
    : -1;
  const scrollTarget =
    follow && (isPlaying || selectedIndex < 0) ? Math.max(0, nowIndex - 1) : selectedIndex;

  useEffect(() => {
    const element = scrollRef.current;

    if (!element || scrollTarget < 0 || scrollTarget >= entries.length) {
      return;
    }

    const row = virtualizer.measurementsCache[scrollTarget];
    const top = row?.start ?? scrollTarget * ROW_ESTIMATE;
    const bottom = row?.end ?? top + ROW_ESTIMATE;

    // Only when the row is (partly) out of view, so following the playhead does not jitter.
    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) {
      virtualizer.scrollToIndex(scrollTarget, { align: "center" });
    }
  }, [scrollTarget, entries.length, virtualizer]);

  const onSelect = useCallback(
    (eventId: string) => {
      const event = archive?.model.eventById.get(eventId);

      if (event) {
        controller.selectEvent(event);
      }
    },
    [archive, controller]
  );
  const onToggle = useCallback(
    (eventId: string) => updateSlice((current) => toggleExpanded(current, eventId)),
    [updateSlice]
  );

  if (!archive || !context) {
    return null;
  }

  if (entries.length === 0) {
    return (
      <p className="list-empty" data-testid="event-list-empty">
        {t("listEmpty")}
      </p>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      controller.stepList(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    const selected = entries[selectedIndex];

    // Right opens the selected "×N" row, Left closes it (like a tree).
    if (
      selected &&
      selected.count > 1 &&
      ((event.key === "ArrowRight" && !selected.expanded) ||
        (event.key === "ArrowLeft" && selected.expanded))
    ) {
      event.preventDefault();
      onToggle(selected.item.eventId);
    }
  };

  // The getters refresh the measurements; `measurementsCache` read before them is one layout old.
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const nowTop =
    nowIndex < entries.length
      ? (virtualizer.measurementsCache[nowIndex]?.start ?? nowIndex * ROW_ESTIMATE)
      : totalSize;

  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={t("tabLabel")}
      aria-activedescendant={selectedIndex >= 0 ? `evt-${selectedEventId}` : undefined}
      className="vlist feed"
      onKeyDown={handleKeyDown}
      data-testid="event-list"
      data-searching={view?.searching}
    >
      <div className="vlist-canvas" style={{ height: totalSize }}>
        {virtualRows.map((row) => {
          const entry = entries[row.index];

          return entry ? (
            <FeedRow
              key={row.key}
              entry={entry}
              index={row.index}
              context={context}
              minMono={archive.model.minMono}
              selected={entry.item.eventId === selectedEventId}
              future={row.index >= nowIndex}
              measure={virtualizer.measureElement}
              start={row.start}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ) : null;
        })}
        <div className="nowline" style={{ top: nowTop }} aria-hidden="true" data-testid="now-line">
          <NowLabel />
        </div>
      </div>
    </div>
  );
}
