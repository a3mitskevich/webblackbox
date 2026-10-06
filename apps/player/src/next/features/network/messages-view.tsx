import { useCallback, useId, useMemo, useState, type KeyboardEvent } from "react";

import {
  isRealtimePayloadCut,
  isServiceRealtimeRecord,
  parseRealtimePayload,
  realtimeMessageBytes,
  type ParsedRealtimePayload,
  type RealtimeNetworkEntry,
  type RealtimeRecord,
  type RealtimeStream
} from "@webblackbox/player-sdk";

import { formatOffset } from "../../../core/format.js";
import { Icon } from "../../components/icon.js";
import { VirtualList } from "../../components/virtual-list.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import { useFeatureI18n } from "../messages.js";
import { CodeView } from "./code-view.js";
import { decodeBase64, formatPartialJson } from "./formatters.js";
import { nextListIndex, pageRowsOf, rowDomId } from "./list-keys.js";
import { networkMessages, type NetworkTranslator } from "./messages.js";
import { useRealtimeText } from "./use-archive-data.js";
import { HexView } from "./viewers.js";

const MESSAGE_ROW_HEIGHT = 26;
/** Inline (non-virtualized) code blocks up to this many lines; longer ones scroll. */
const INLINE_MAX_LINES = 400;

/** What a conversation row shows: the hub method (or kind) and a one-line preview. */
export type MessageLabel = {
  entry: RealtimeNetworkEntry;
  parsed: ParsedRealtimePayload;
  title: string | null;
  preview: string;
  service: boolean;
};

function previewOf(record: RealtimeRecord | undefined): string {
  if (!record) {
    return "";
  }

  const value = record.value as { arguments?: unknown } | undefined;

  if (record.target && value && value.arguments !== undefined) {
    return JSON.stringify(value.arguments);
  }

  return record.text.replace(/\s+/g, " ");
}

export function labelMessage(entry: RealtimeNetworkEntry, signalr: boolean): MessageLabel {
  const parsed = parseRealtimePayload(entry.payloadPreview, {
    truncated: isRealtimePayloadCut(entry),
    opcode: entry.opcode,
    signalr
  });
  const first = parsed.records[0];

  return {
    entry,
    parsed,
    title: first?.target ?? null,
    preview: previewOf(first),
    service: parsed.records.length > 0 && parsed.records.every(isServiceRealtimeRecord)
  };
}

/** Labels of a stream's messages, optionally without the service ones. */
export function useMessageLabels(stream: RealtimeStream, hideService: boolean): MessageLabel[] {
  return useMemo(() => {
    const signalr = stream.format === "signalr";
    const labels = stream.messages.map((entry) => labelMessage(entry, signalr));
    return hideService ? labels.filter((label) => !label.service) : labels;
  }, [stream, hideService]);
}

export function kindText(t: NetworkTranslator, record: RealtimeRecord | undefined): string {
  return record ? t(`kind_${record.kind}`) : t("kind_empty");
}

export function directionOf(entry: RealtimeNetworkEntry): "sent" | "received" {
  return entry.direction === "sent" ? "sent" : "received";
}

type MessageListProps = {
  labels: MessageLabel[];
  selectedId: string | null;
  minMono: number;
};

/**
 * The dense message list of a socket (Network details, Messages tab): a listbox where ↑ / ↓,
 * PageUp / PageDown, Home / End move the selection while it has focus.
 */
export function MessageList({ labels, selectedId, minMono }: MessageListProps) {
  const controller = useController();
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const idPrefix = useId();
  const [mounted, setMounted] = useState({ first: -1, last: -1 });
  const onRangeChange = useCallback(
    (first: number, last: number) => setMounted({ first, last }),
    []
  );
  const selectedIndex = labels.findIndex((label) => label.entry.eventId === selectedId);
  // Only a mounted row can be the active descendant (a virtualized-out id would dangle).
  const isSelectedMounted = selectedIndex >= mounted.first && selectedIndex <= mounted.last;

  if (labels.length === 0) {
    return <p className="nbody-note">{t("messagesEmpty")}</p>;
  }

  const select = (entry: RealtimeNetworkEntry): void => {
    controller.select({ kind: "event", id: entry.eventId });
    controller.openDetails();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const pageRows = pageRowsOf(event.currentTarget, MESSAGE_ROW_HEIGHT);
    const index = nextListIndex(event.key, selectedIndex, labels.length, pageRows);
    const next = index === null ? undefined : labels[index];

    if (!next) {
      return;
    }

    event.preventDefault();

    if (index !== selectedIndex) {
      select(next.entry);
    }
  };

  return (
    <VirtualList
      role="listbox"
      tabIndex={0}
      aria-label={t("messagesLabel")}
      aria-activedescendant={isSelectedMounted ? rowDomId(idPrefix, selectedIndex) : undefined}
      className="frames"
      itemCount={labels.length}
      rowHeight={MESSAGE_ROW_HEIGHT}
      scrollToIndex={selectedIndex}
      onKeyDown={handleKeyDown}
      onRangeChange={onRangeChange}
      testId="message-list"
      renderRow={(index) => {
        const label = labels[index];

        if (!label) {
          return null;
        }

        const { entry } = label;
        const direction = directionOf(entry);
        const isSelected = entry.eventId === selectedId;

        return (
          <div
            key={entry.eventId}
            id={rowDomId(idPrefix, index)}
            role="option"
            aria-selected={isSelected}
            className={["nmsg", isSelected ? "nsel" : "", label.service ? "ndim" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => select(entry)}
            data-testid="message-row"
            data-event-id={entry.eventId}
          >
            <time className="mono">{formatOffset(entry.mono - minMono, locale)}</time>
            <span
              className={`ndir ${direction}`}
              role="img"
              aria-label={t(`direction_${direction}`)}
            >
              <Icon name={direction} />
            </span>
            <span className="p mono">
              {label.title ? <b>{label.title}</b> : null} {label.preview}
            </span>
            <span className="sz mono">
              {i18n.formatByteSize(realtimeMessageBytes(entry))}
              {isRealtimePayloadCut(entry) ? <span className="ncut">{t("cutShort")}</span> : null}
            </span>
          </div>
        );
      }}
    />
  );
}

function RecordBody({
  record,
  missingBytes
}: {
  record: RealtimeRecord;
  /** Bytes the recorder did not keep after this (cut) record. */
  missingBytes: number;
}) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  // Payloads run to megabytes: decode and pretty-print once per record, not on every render.
  const bytes = useMemo(
    () => (record.kind === "binary" ? decodeBase64(record.text) : null),
    [record]
  );
  const isJson = record.value !== undefined || (!record.complete && record.kind !== "text");
  const text = useMemo(() => {
    if (record.kind === "binary") {
      return record.text;
    }

    if (record.value !== undefined) {
      return JSON.stringify(record.value, null, 2);
    }

    return isJson ? formatPartialJson(record.text) : record.text;
  }, [record, isJson]);
  const lines = useMemo(() => text.split("\n").length, [text]);

  if (record.kind === "binary") {
    return bytes ? (
      <HexView bytes={bytes} testId="message-hex" />
    ) : (
      <CodeView inline text={record.text} language="plain" />
    );
  }

  return (
    <>
      <CodeView
        inline={lines <= INLINE_MAX_LINES}
        text={text}
        language={isJson ? "json" : "plain"}
      />
      {!record.complete && missingBytes > 0 ? (
        <p className="nrest mono" data-testid="message-rest">
          {t("notCapturedRest", { size: i18n.formatByteSize(missingBytes) })}
        </p>
      ) : null}
    </>
  );
}

type MessageViewProps = {
  entry: RealtimeNetworkEntry;
  stream: RealtimeStream;
  minMono: number;
};

/**
 * One WebSocket frame or SSE message, read: the whole payload (blob for large frames), SignalR
 * records split and pretty-printed, a cut message re-indented up to where the recording stopped.
 */
export function MessageView({ entry, stream, minMono }: MessageViewProps) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const text = useRealtimeText(entry);
  const loaded = text?.status === "ready" ? text.value : null;
  const parsed = useMemo(
    () =>
      parseRealtimePayload(loaded ?? entry.payloadPreview, {
        truncated: isRealtimePayloadCut(entry),
        opcode: entry.opcode,
        signalr: stream.format === "signalr"
      }),
    [loaded, entry, stream.format]
  );
  const direction = directionOf(entry);
  const first = parsed.records[0];
  // Kept and total in the SDK's units (characters of text, bytes of binary frames): the kept text
  // measured as if it were the whole message.
  const keptBytes = useMemo(() => {
    const kept = loaded ?? entry.payloadPreview ?? "";
    return realtimeMessageBytes({ ...entry, payloadPreview: kept, payloadLength: kept.length });
  }, [loaded, entry]);
  const totalBytes = realtimeMessageBytes(entry);
  const missingBytes = Math.max(0, totalBytes - keptBytes);

  return (
    <section className="nmessage-view" aria-label={t("messagesLabel")} data-testid="message-view">
      <header className="ndh">
        <h3>
          <Icon name={direction} />
          {first?.target ?? kindText(t, first)}
        </h3>
        <div className="nsub">
          <span>
            {t("messageAt", {
              direction: t(`direction_${direction}`),
              time: formatOffset(entry.mono - minMono, locale)
            })}
          </span>
          <span>
            {kindText(t, first)}
            {first?.signalrType !== undefined
              ? ` · ${t("signalrType", { type: first.signalrType })}`
              : ""}
          </span>
          {first?.invocationId ? (
            <span>{t("invocationId", { id: first.invocationId })}</span>
          ) : null}
          <span>{i18n.formatByteSize(totalBytes)}</span>
        </div>
      </header>
      {parsed.truncated ? (
        <p className="nnotice warn" data-testid="message-cut">
          {totalBytes > keptBytes
            ? t("messageCut", {
                kept: i18n.formatByteSize(keptBytes),
                total: i18n.formatByteSize(totalBytes)
              })
            : t("messageCutPlain")}
        </p>
      ) : null}
      {text?.status === "error" ? (
        <p className="nnotice bad">{t("payloadLoadFailed", { error: text.message })}</p>
      ) : null}
      <div className="nrecords" data-testid="message-records">
        {parsed.records.map((record, index) => (
          // Keyed per message: a record's view state ("Highlight anyway") stays with it.
          <div key={`${entry.eventId}:${index}`} className="nrecord" data-kind={record.kind}>
            {parsed.records.length > 1 ? (
              <h4 className="nrecord-head">
                {t("recordOf", { index: index + 1, count: parsed.records.length })} ·{" "}
                {record.target ?? kindText(t, record)}
              </h4>
            ) : null}
            {record.error ? (
              <p className="nnotice bad">{t("hubError", { error: record.error })}</p>
            ) : null}
            <RecordBody
              record={record}
              missingBytes={index === parsed.records.length - 1 ? missingBytes : 0}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
