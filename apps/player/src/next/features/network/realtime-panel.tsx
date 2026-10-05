import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";

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
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const follow = usePlayerState((state) => state.follow);
  const isPlaying = usePlayerState((state) => state.isPlaying);
  const nowMono = useNowMono();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: labels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (labels[index]?.service ? SERVICE_ESTIMATE : BUBBLE_ESTIMATE),
    overscan: OVERSCAN,
    // React 19 warns about flushSync inside lifecycle methods (LIBRARIES.md).
    useFlushSync: false
  });
  const lastPast = labels.reduce(
    (found, label, index) => (label.entry.mono <= nowMono ? index : found),
    -1
  );
  const selectedIndex = labels.findIndex((label) => label.entry.eventId === selectedId);
  const target = isPlaying && follow ? lastPast : selectedIndex;

  useEffect(() => {
    if (target >= 0) {
      virtualizer.scrollToIndex(target, { align: "auto" });
    }
  }, [target, virtualizer]);

  if (labels.length === 0) {
    return <p className="list-empty">{t("messagesEmpty")}</p>;
  }

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="convo"
      role="listbox"
      aria-label={t("conversationLabel")}
      data-testid="conversation"
    >
      <div className="vlist-canvas" style={{ height: virtualizer.getTotalSize() }}>
        <div
          className="vlist-window"
          style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}
        >
          {items.map((item) => {
            const label = labels[item.index];

            if (!label) {
              return null;
            }

            const { entry } = label;
            const direction = directionOf(entry);
            const isSelected = entry.eventId === selectedId;
            const className = [
              "bubble",
              direction,
              label.service ? "nservice" : "",
              isSelected ? "nsel" : "",
              entry.mono > nowMono ? "nfuture" : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <div
                key={entry.eventId}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className={`bubble-row ${direction}`}
              >
                <div
                  role="option"
                  aria-selected={isSelected}
                  className={className}
                  onClick={() => {
                    controller.select({ kind: "event", id: entry.eventId });
                    controller.openDetails();
                  }}
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
                    {isRealtimePayloadCut(entry) ? <span className="ncut">cut</span> : null}
                  </div>
                  {label.service ? null : <div className="bubble-text mono">{label.preview}</div>}
                </div>
              </div>
            );
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
