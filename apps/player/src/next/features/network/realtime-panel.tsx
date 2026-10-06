import {
  observeElementRect,
  useVirtualizer,
  type Rect,
  type Virtualizer
} from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useId, useMemo, useRef, type KeyboardEvent } from "react";

import {
  isRealtimePayloadCut,
  realtimeMessageBytes,
  type RealtimeStream
} from "@webblackbox/player-sdk";

import { formatOffset } from "../../../core/format.js";
import { Icon } from "../../components/icon.js";
import { ListDetailsSplit } from "../../components/split-layout.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { nextListIndex, pageRowsOf, rowDomId } from "./list-keys.js";
import { networkMessages } from "./messages.js";
import {
  directionOf,
  kindText,
  MessageView,
  useMessageLabels,
  type MessageLabel
} from "./messages-view.js";
import {
  socketPath,
  socketRowId,
  socketSelection,
  streamOfSelection,
  type NetworkModel
} from "./rows.js";
import { networkSlice } from "./slice.js";
import { useNetworkModel, useNowMono } from "./use-network.js";
import "./network.css";

const BUBBLE_ESTIMATE = 54;
const SERVICE_ESTIMATE = 30;
const OVERSCAN = 6;
const REALTIME_DETAILS_PERCENT = 55;
/** Like components/virtual-list.tsx: a list not laid out yet (hidden, jsdom) still renders rows. */
const FALLBACK_VIEWPORT_HEIGHT = 480;

function observeRectWithFallback(
  instance: Virtualizer<HTMLDivElement, Element>,
  onRect: (rect: Rect) => void
): void | (() => void) {
  return observeElementRect(instance, (rect) =>
    onRect(rect.height > 0 ? rect : { width: rect.width, height: FALLBACK_VIEWPORT_HEIGHT })
  );
}

const EMPTY_STREAM: RealtimeStream = {
  streamId: "",
  protocol: "ws",
  firstMono: 0,
  lastMono: 0,
  messages: [],
  sent: 0,
  received: 0,
  sentBytes: 0,
  receivedBytes: 0,
  truncated: 0,
  format: "empty"
};

/** The stream the tab shows: the selected message's, else the chosen one, else the first. */
function useShownStream(model: NetworkModel | null): RealtimeStream | null {
  const selection = usePlayerState((state) => state.selection);
  const chosen = useFeatureSlice(networkSlice, (slice) => slice.realtimeStreamKey);

  return useMemo(() => {
    if (!model || model.streams.length === 0) {
      return null;
    }

    return (
      streamOfSelection(model, selection) ??
      model.streams.find((stream) => socketRowId(stream) === chosen) ??
      // The busiest connection, not the first: sockets opened before the recording come first.
      model.streams.reduce<RealtimeStream | null>(
        (busiest, stream) =>
          !busiest || stream.messages.length > busiest.messages.length ? stream : busiest,
        null
      )
    );
  }, [model, selection, chosen]);
}

/** Index of the last message at or before `mono` (labels are in time order), or -1. */
function lastIndexAtOrBefore(labels: readonly MessageLabel[], mono: number): number {
  let low = 0;
  let high = labels.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((labels[middle]?.entry.mono ?? Infinity) <= mono) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low - 1;
}

type BubbleProps = {
  label: MessageLabel;
  index: number;
  domId: string;
  isSelected: boolean;
  isFuture: boolean;
  minMono: number;
  measureRef: (element: HTMLElement | null) => void;
  onSelect: (eventId: string) => void;
};

/**
 * One message of the conversation. Memoized: the list re-renders on every playhead step while
 * playing, a bubble only when it is selected or crosses the playhead.
 */
const Bubble = memo(function Bubble({
  label,
  index,
  domId,
  isSelected,
  isFuture,
  minMono,
  measureRef,
  onSelect
}: BubbleProps) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { entry } = label;
  const direction = directionOf(entry);
  const className = [
    "bubble",
    direction,
    label.service ? "nservice" : "",
    isSelected ? "nsel" : "",
    isFuture ? "nfuture" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={measureRef} data-index={index} className={`bubble-row ${direction}`}>
      <div
        id={domId}
        role="option"
        aria-selected={isSelected}
        className={className}
        onClick={() => onSelect(entry.eventId)}
        data-testid="conversation-message"
        data-event-id={entry.eventId}
        data-direction={direction}
      >
        <div className="bubble-head">
          <span className="ndir" role="img" aria-label={t(`direction_${direction}`)}>
            <Icon name={direction} />
          </span>
          <b>{label.title ?? kindText(t, label.parsed.records[0])}</b>
          <span className="muted mono">
            {formatOffset(entry.mono - minMono, locale)} ·{" "}
            {i18n.formatByteSize(realtimeMessageBytes(entry))}
          </span>
          {isRealtimePayloadCut(entry) ? <span className="ncut">{t("cutShort")}</span> : null}
        </div>
        {label.service ? null : <div className="bubble-text mono">{label.preview}</div>}
      </div>
    </div>
  );
});

/**
 * The conversation as a listbox: ↑ / ↓, PageUp / PageDown, Home / End move the selection while
 * it has focus; bubbles have variable heights (measured), keyed by event id.
 */
function Conversation({
  labels,
  selectedId,
  minMono
}: {
  labels: MessageLabel[];
  selectedId: string | null;
  minMono: number;
}) {
  const controller = useController();
  const t = useFeatureI18n(networkMessages);
  const follow = usePlayerState((state) => state.follow);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const nowMono = useNowMono();
  const idPrefix = useId();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: labels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (labels[index]?.service ? SERVICE_ESTIMATE : BUBBLE_ESTIMATE),
    // Measured heights follow the message, not its position in the (filtered) list.
    getItemKey: (index) => labels[index]?.entry.eventId ?? index,
    overscan: OVERSCAN,
    observeElementRect: observeRectWithFallback,
    // React 19 warns about flushSync inside lifecycle methods (LIBRARIES.md).
    useFlushSync: false
  });
  const lastPast = lastIndexAtOrBefore(labels, nowMono);
  const selectedIndex = labels.findIndex((label) => label.entry.eventId === selectedId);
  const target = isPlaying && follow ? lastPast : selectedIndex;

  const select = useCallback(
    (eventId: string) => {
      controller.select({ kind: "event", id: eventId });
      controller.openDetails();
    },
    [controller]
  );

  useEffect(() => {
    if (target >= 0) {
      virtualizer.scrollToIndex(target, { align: "auto" });
    }
  }, [target, virtualizer]);

  if (labels.length === 0) {
    return <p className="list-empty">{t("messagesEmpty")}</p>;
  }

  const items = virtualizer.getVirtualItems();
  const isSelectedMounted = items.some((item) => item.index === selectedIndex);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const pageRows = pageRowsOf(event.currentTarget, BUBBLE_ESTIMATE);
    const index = nextListIndex(event.key, selectedIndex, labels.length, pageRows);
    const next = index === null ? undefined : labels[index];

    if (!next) {
      return;
    }

    event.preventDefault();

    if (index !== selectedIndex) {
      select(next.entry.eventId);
    }
  };

  return (
    <div
      ref={parentRef}
      className="convo"
      role="listbox"
      tabIndex={0}
      aria-label={t("conversationLabel")}
      aria-activedescendant={isSelectedMounted ? rowDomId(idPrefix, selectedIndex) : undefined}
      onKeyDown={handleKeyDown}
      data-testid="conversation"
    >
      <div className="vlist-canvas" style={{ height: virtualizer.getTotalSize() }}>
        <div
          className="vlist-window"
          style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}
        >
          {items.map((item) => {
            const label = labels[item.index];

            return label ? (
              <Bubble
                key={item.key}
                label={label}
                index={item.index}
                domId={rowDomId(idPrefix, item.index)}
                isSelected={label.entry.eventId === selectedId}
                isFuture={label.entry.mono > nowMono}
                minMono={minMono}
                measureRef={virtualizer.measureElement}
                onSelect={select}
              />
            ) : null;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The Realtime rail tab: one WebSocket / SSE connection at a time as a conversation (Casefile
 * borrowing, PROPOSAL §10): sent on the right, received on the left, service messages dimmed;
 * the selected message is read in full under it.
 */
export default function RealtimePanel() {
  const controller = useController();
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const model = useNetworkModel();
  const stream = useShownStream(model);
  const hideService = useFeatureSlice(networkSlice, (slice) => slice.hideService);
  const update = useFeatureSliceUpdate(networkSlice);
  const selection = usePlayerState((state) => state.selection);
  const detailsOpen = usePlayerState((state) => state.detailsOpen);
  const minMono = usePlayerState((state) => state.archive?.model.minMono ?? 0);
  const labels = useMessageLabels(stream ?? EMPTY_STREAM, hideService);

  if (!model) {
    return null;
  }

  if (!stream) {
    return (
      <p className="list-empty" data-testid="realtime-empty">
        {t("noRealtime")}
      </p>
    );
  }

  const selected =
    selection?.kind === "event"
      ? (stream.messages.find((message) => message.eventId === selection.id) ?? null)
      : null;

  const openInNetwork = () => {
    const target = socketSelection(stream);

    if (target) {
      controller.setTab("network");
      controller.select(target);
      controller.openDetails();
    }
  };

  return (
    <>
      <div className="rail-tools nrealtime-tools">
        <label className="field nstream-pick">
          <Icon name="ws" />
          <span className="visually-hidden">{t("streamsLabel")}</span>
          <select
            value={socketRowId(stream)}
            onChange={(event) => {
              const key = event.target.value;
              const next = model.streams.find((item) => socketRowId(item) === key);
              const target = next ? socketSelection(next) : null;
              update((slice) => ({ ...slice, realtimeStreamKey: key }));

              if (target) {
                controller.select(target);
              }
            }}
            data-testid="stream-select"
          >
            {model.streams.map((item) => (
              <option key={socketRowId(item)} value={socketRowId(item)}>
                {t(`protocol_${item.protocol}`)} ·{" "}
                {(() => {
                  const path = socketPath(item);
                  return path
                    ? `${path.host}${path.path}`
                    : t("socketNoUrl", { id: item.streamId });
                })()}{" "}
                · {i18n.formatNumber(item.messages.length)}
              </option>
            ))}
          </select>
        </label>
        <label className="ncheck">
          <input
            type="checkbox"
            checked={hideService}
            onChange={(event) => {
              const checked = event.target.checked;
              update((slice) => ({ ...slice, hideService: checked }));
            }}
            data-testid="hide-service"
          />
          {t("hideService")}
        </label>
        <button
          type="button"
          className="btn small"
          onClick={openInNetwork}
          data-testid="open-in-network"
        >
          {t("openInNetwork")}
        </button>
      </div>
      <ListDetailsSplit
        name="realtime"
        detailsPercent={REALTIME_DETAILS_PERCENT}
        list={
          <Conversation labels={labels} selectedId={selected?.eventId ?? null} minMono={minMono} />
        }
        details={
          detailsOpen && selected ? (
            <div className="nrealtime-detail">
              <MessageView entry={selected} stream={stream} minMono={minMono} />
            </div>
          ) : null
        }
      />
    </>
  );
}
