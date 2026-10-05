import { useMemo, useCallback, type KeyboardEvent } from "react";

import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { describeEventRow, type EventRowKind } from "../../../core/event-row.js";
import { formatClock, formatOffset } from "../../../core/format.js";
import { upperBoundByMono } from "../../../lib/range.js";
import { Icon, type IconName } from "../../components/icon.js";
import { VirtualList } from "../../components/virtual-list.js";
import { useController, usePlayerState } from "../../context.js";
import { resolveSelectedEventId, selectActivityEvents } from "../../controller.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { feedMessages } from "./messages.js";

/** Two-line rows (DevTools-like density comes with R3's network table). */
export const EVENT_ROW_HEIGHT = 52;
/** The list re-renders "past/future" at most this often while playing. */
const NOW_BUCKET_MS = 120;

const ROW_ICONS: Record<EventRowKind, IconName> = {
  action: "click",
  navigation: "nav",
  request: "req",
  error: "error",
  realtime: "ws",
  console: "console",
  storage: "storage",
  media: "media",
  meta: "flag"
};

type EventRowProps = {
  event: WebBlackboxEvent;
  archive: LoadedArchive;
  locale: string;
  selected: boolean;
  future: boolean;
  onSelect: (event: WebBlackboxEvent) => void;
};

function EventRow({ event, archive, locale, selected, future, onSelect }: EventRowProps) {
  const row = describeEventRow(event, archive.model);
  const classes = ["fi", `fi-${row.kind}`, selected ? "cur" : "", future ? "future" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="option"
      id={`evt-${event.id}`}
      aria-selected={selected}
      className={classes}
      onClick={() => onSelect(event)}
      data-testid="event-row"
      data-event-id={event.id}
      data-future={future}
    >
      <time>{formatOffset(event.mono - archive.model.minMono, locale)}</time>
      <span className="gl">
        <Icon name={ROW_ICONS[row.kind]} />
      </span>
      <div className="tt">
        <div className="t1">
          {row.status !== null ? <span className="code mono">{row.status} </span> : null}
          <span className="type mono">{event.type}</span> <span>{row.primary}</span>
        </div>
        {row.secondary ? <div className="t2">{row.secondary}</div> : null}
      </div>
    </div>
  );
}

/** "0:10.89 · now": the only part of the list that follows the playhead on every frame. */
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

/**
 * Activity tab of R1: every meaningful event (all times, the future dimmed) with the "now" line.
 * R2 replaces it with the action → consequences feed.
 */
export function EventList() {
  const controller = useController();
  const t = useFeatureI18n(feedMessages);
  const archive = usePlayerState((state) => state.archive);
  const query = usePlayerState((state) => state.query);
  const locale = usePlayerState((state) => state.locale);
  const follow = usePlayerState((state) => state.follow);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const selectedId = usePlayerState((state) =>
    state.archive ? resolveSelectedEventId(state.archive, state.selection) : null
  );
  // Exact while paused; while playing the list follows in NOW_BUCKET_MS steps, not every frame.
  const nowMono = usePlayerState((state) =>
    state.isPlaying
      ? Math.floor(state.playheadMono / NOW_BUCKET_MS) * NOW_BUCKET_MS
      : state.playheadMono
  );
  const events = useMemo(
    () => (archive ? selectActivityEvents(archive, query) : []),
    [archive, query]
  );
  // Rows at or before the playhead are the past; the label shows the exact playhead.
  const nowIndex = upperBoundByMono(events, nowMono, (event) => event.mono);
  const selectedIndex = selectedId ? events.findIndex((event) => event.id === selectedId) : -1;
  const scrollTarget = isPlaying && follow ? Math.max(0, nowIndex - 1) : selectedIndex;
  const onSelect = useCallback(
    (event: WebBlackboxEvent) => controller.selectEvent(event),
    [controller]
  );

  if (!archive) {
    return null;
  }

  if (events.length === 0) {
    return (
      <p className="list-empty" data-testid="event-list-empty">
        {t("listEmpty")}
      </p>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }

    event.preventDefault();
    controller.stepList(event.key === "ArrowDown" ? 1 : -1);
  };

  const nowLine = (
    <div
      className="nowline"
      style={{ top: nowIndex * EVENT_ROW_HEIGHT }}
      aria-hidden="true"
      data-testid="now-line"
    >
      <NowLabel />
    </div>
  );

  return (
    <VirtualList
      role="listbox"
      tabIndex={0}
      aria-label={t("tabLabel")}
      aria-activedescendant={selectedIndex >= 0 ? `evt-${selectedId}` : undefined}
      className="feed"
      itemCount={events.length}
      rowHeight={EVENT_ROW_HEIGHT}
      scrollToIndex={scrollTarget}
      overlay={nowLine}
      onKeyDown={handleKeyDown}
      testId="event-list"
      renderRow={(index) => {
        const event = events[index];

        return event ? (
          <EventRow
            key={event.id}
            event={event}
            archive={archive}
            locale={locale}
            selected={event.id === selectedId}
            future={index >= nowIndex}
            onSelect={onSelect}
          />
        ) : null;
      }}
    />
  );
}
