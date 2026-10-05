import { Tabs } from "@base-ui/react/tabs";
import { useState, type ReactNode } from "react";

import { maskSensitiveUrl, type RealtimeStream } from "@webblackbox/player-sdk";

import { formatOffset } from "../../../core/format.js";
import { resolveNetworkInitiator } from "../../../lib/network-labels.js";
import { formatNetworkSize } from "../../../lib/network-size.js";
import { describeNetworkStatus } from "../../../lib/network-view.js";
import { Hint } from "../../components/hint.js";
import { Icon } from "../../components/icon.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice, useFeatureSliceUpdate } from "../slice.js";
import { CopyButton } from "./copy-button.js";
import { networkMessages } from "./messages.js";
import { MessageList, MessageView, useMessageLabels } from "./messages-view.js";
import { statusTone } from "./network-table.js";
import { replayRequest, type ReplayOutcome } from "./replay.js";
import {
  HeadersTab,
  InitiatorTab,
  KeyValues,
  PayloadTab,
  RequestTimingTab,
  ResponseTab,
  Section,
  TimingView,
  useConnection,
  useModelEvents
} from "./request-tabs.js";
import type { NetworkRow } from "./rows.js";
import { networkSlice, type NetworkDetailTab } from "./slice.js";

type HttpRow = Extract<NetworkRow, { kind: "http" }>;
type SocketRow = Extract<NetworkRow, { kind: "socket" }>;

const HTTP_TABS: readonly NetworkDetailTab[] = [
  "headers",
  "payload",
  "response",
  "timing",
  "initiator"
];
const SOCKET_TABS: readonly NetworkDetailTab[] = ["messages", "headers", "timing", "initiator"];
const ALL_TABS: ReadonlySet<string> = new Set([...HTTP_TABS, ...SOCKET_TABS]);

function isDetailTab(value: unknown): value is NetworkDetailTab {
  return typeof value === "string" && ALL_TABS.has(value);
}

function DetailTabs({
  available,
  panels,
  counts = {}
}: {
  available: readonly NetworkDetailTab[];
  panels: Partial<Record<NetworkDetailTab, ReactNode>>;
  counts?: Partial<Record<NetworkDetailTab, number>>;
}) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const stored = useFeatureSlice(networkSlice, (slice) => slice.detailTab);
  const update = useFeatureSliceUpdate(networkSlice);
  const tab = available.includes(stored) ? stored : (available[0] as NetworkDetailTab);

  return (
    <Tabs.Root
      className="dtabs"
      value={tab}
      onValueChange={(value) => {
        if (isDetailTab(value)) {
          update((slice) => ({ ...slice, detailTab: value }));
        }
      }}
    >
      <Tabs.List className="subtabs" aria-label={t("detailTabsLabel")} activateOnFocus>
        {available.map((name) => (
          <Tabs.Tab key={name} value={name} className="subtab" data-testid={`detail-tab-${name}`}>
            {t(`tab_${name}`)}
            {counts[name] !== undefined ? (
              <span className="c"> {i18n.formatNumber(counts[name] ?? 0)}</span>
            ) : null}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {available.map((name) => (
        <Tabs.Panel key={name} value={name} className="dpanel" data-testid={`detail-panel-${name}`}>
          {name === tab ? panels[name] : null}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

function HiddenParamsChip({ params }: { params: string[] }) {
  const t = useFeatureI18n(networkMessages);

  if (params.length === 0) {
    return null;
  }

  return (
    <Hint label={t("hiddenParamsHint")}>
      <span className="chip" tabIndex={0} data-testid="hidden-params">
        {t("hiddenParams", { params: params.join(", ") })}
      </span>
    </Hint>
  );
}

function CloseButton() {
  const controller = useController();
  const t = useFeatureI18n(networkMessages);

  return (
    <button
      type="button"
      className="btn icon-only small"
      aria-label={t("closeDetails")}
      onClick={() => controller.close()}
      data-testid="close-details"
    >
      <Icon name="close" />
    </button>
  );
}

function ReplayResult({
  outcome,
  recordedStatus
}: {
  outcome: ReplayOutcome;
  recordedStatus: string;
}) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();

  if (!outcome.ok) {
    return <span className="bad">{t("replayFailed", { error: outcome.error })}</span>;
  }

  const comparison =
    outcome.bodyMatches === null
      ? t("replayNoBody")
      : outcome.bodyMatches
        ? t("replaySame")
        : t("replayDifferent", { size: i18n.formatByteSize(outcome.bodyBytes) });

  return (
    <span>
      {t("replayResult", {
        status: `${outcome.status}${outcome.statusText ? ` ${outcome.statusText}` : ""}`,
        time: i18n.formatMilliseconds(outcome.durationMs, { fractionDigits: 0 }),
        recorded: recordedStatus
      })}
      {" · "}
      {comparison}
    </span>
  );
}

function RequestActions({ row, archive }: { row: HttpRow; archive: LoadedArchive }) {
  const t = useFeatureI18n(networkMessages);
  const locale = usePlayerState((state) => state.locale);
  const [replay, setReplay] = useState<{
    reqId: string;
    outcome: ReplayOutcome | null;
  } | null>(null);
  const { entry } = row;
  const current = replay?.reqId === entry.reqId ? replay : null;
  const isRunning = current !== null && current.outcome === null;

  const runReplay = async (): Promise<void> => {
    setReplay({ reqId: entry.reqId, outcome: null });
    const outcome = await replayRequest(entry);
    setReplay((value) => (value?.reqId === entry.reqId ? { reqId: entry.reqId, outcome } : value));
  };

  return (
    <>
      <div className="dactions">
        <CopyButton label={t("copyUrl")} getText={() => entry.url} testId="copy-url" />
        <CopyButton
          label={t("copyCurl")}
          getText={() => archive.player.generateCurl(entry.reqId)}
          testId="copy-curl"
        />
        <CopyButton
          label={t("copyFetch")}
          getText={() => archive.player.generateFetch(entry.reqId)}
          testId="copy-fetch"
        />
        <Hint label={t("replayHint")}>
          <button
            type="button"
            className="btn small"
            disabled={isRunning}
            onClick={() => void runReplay()}
            data-testid="replay-request"
          >
            <Icon name="replay" />
            <span>{isRunning ? t("replaying") : t("replay")}</span>
          </button>
        </Hint>
      </div>
      {current?.outcome ? (
        <p className="replay-line" role="status" data-testid="replay-result">
          <ReplayResult
            outcome={current.outcome}
            recordedStatus={describeNetworkStatus(entry, locale)}
          />
        </p>
      ) : null}
    </>
  );
}

/** Messages of a socket or SSE stream: the dense list beside the selected message. */
function StreamMessages({ stream, archive }: { stream: RealtimeStream; archive: LoadedArchive }) {
  const t = useFeatureI18n(networkMessages);
  const hideService = useFeatureSlice(networkSlice, (slice) => slice.hideService);
  const labels = useMessageLabels(stream, hideService);
  const selection = usePlayerState((state) => state.selection);
  const selected =
    selection?.kind === "event"
      ? (stream.messages.find((message) => message.eventId === selection.id) ?? null)
      : null;

  return (
    <div className="two" data-testid="stream-messages">
      <MessageList
        labels={labels}
        selectedId={selected?.eventId ?? null}
        minMono={archive.model.minMono}
      />
      <div className="two-detail">
        {selected ? (
          <MessageView entry={selected} stream={stream} minMono={archive.model.minMono} />
        ) : (
          <p className="body-note">{t("messageSelectHint")}</p>
        )}
      </div>
    </div>
  );
}

function RequestDetails({ row, archive }: { row: HttpRow; archive: LoadedArchive }) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { entry } = row;
  const events = useModelEvents(archive, entry.eventIds);
  const connection = useConnection(events);
  const masked = maskSensitiveUrl(entry.url);
  const available: readonly NetworkDetailTab[] = row.stream
    ? [...HTTP_TABS, "messages"]
    : HTTP_TABS;

  return (
    <section className="ndetails" aria-label={t("detailsLabel")} data-testid="request-details">
      <header className="dh">
        <div className="dh-top">
          <h2>
            <span className={`st ${statusTone(row)}`}>{describeNetworkStatus(entry, locale)}</span>
            <span className="mono">{entry.method.toUpperCase()}</span>
            <span className="u mono" data-testid="details-url">
              {masked.url}
            </span>
          </h2>
          <CloseButton />
        </div>
        <div className="sub">
          <HiddenParamsChip params={masked.hiddenParams} />
          <span>{formatOffset(entry.startMono - archive.model.minMono, locale)}</span>
          <span>{i18n.formatMilliseconds(entry.durationMs, { fractionDigits: 0 })}</span>
          <span>{formatNetworkSize(entry, locale)}</span>
          {entry.actionId ? <span>{resolveNetworkInitiator(entry, locale)}</span> : null}
          {entry.mimeType ? <span>{entry.mimeType}</span> : null}
        </div>
        <RequestActions row={row} archive={archive} />
      </header>
      <DetailTabs
        available={available}
        counts={row.stream ? { messages: row.stream.messages.length } : {}}
        panels={{
          headers: <HeadersTab entry={entry} connection={connection} />,
          payload: <PayloadTab entry={entry} />,
          response: <ResponseTab entry={entry} />,
          timing: (
            <RequestTimingTab entry={entry} events={events} minMono={archive.model.minMono} />
          ),
          initiator: (
            <InitiatorTab
              archive={archive}
              actionId={entry.actionId}
              connection={connection}
              events={events}
            />
          ),
          messages: row.stream ? <StreamMessages stream={row.stream} archive={archive} /> : null
        }}
      />
    </section>
  );
}

function SocketDetails({ row, archive }: { row: SocketRow; archive: LoadedArchive }) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { stream } = row;
  const openEvents = useModelEvents(archive, stream.openEventId ? [stream.openEventId] : []);
  const connection = useConnection(openEvents);
  const masked = maskSensitiveUrl(stream.url ?? "");
  const count = stream.messages.length;
  const general = [
    [t("field_url"), <span className="mono">{masked.url}</span>],
    [t("field_protocol"), t(`protocol_${stream.protocol}`)],
    [t("field_requestId"), <span className="mono">{stream.streamId}</span>]
  ] as const;

  return (
    <section className="ndetails" aria-label={t("detailsLabel")} data-testid="socket-details">
      <header className="dh">
        <div className="dh-top">
          <h2>
            <Icon name="ws" className="ic ws-glyph" />
            <span className="u mono" data-testid="details-url">
              {masked.url}
            </span>
          </h2>
          <CloseButton />
        </div>
        <div className="sub">
          <HiddenParamsChip params={masked.hiddenParams} />
          {stream.openMono !== undefined ? (
            <span className="st ws">101 Switching Protocols</span>
          ) : null}
          <span>
            {t("socketOpened", {
              time: formatOffset(row.startMono - archive.model.minMono, locale)
            })}
          </span>
          <span>
            {stream.closeMono !== undefined
              ? t("socketOpenFor", { duration: i18n.formatSeconds(row.durationMs) })
              : t("socketStillOpen")}
          </span>
          <span>
            {t(stream.protocol === "ws" ? "socketFrames" : "socketMessages", {
              count: i18n.formatNumber(count),
              size: i18n.formatByteSize(stream.sentBytes + stream.receivedBytes)
            })}
          </span>
          {stream.truncated > 0 ? (
            <span className="warn-text">{t("socketCut", { count: stream.truncated })}</span>
          ) : null}
          <span>{t(`format_${stream.format}`)}</span>
        </div>
      </header>
      <DetailTabs
        available={SOCKET_TABS}
        counts={{ messages: count }}
        panels={{
          messages: <StreamMessages stream={stream} archive={archive} />,
          headers: (
            <div className="dtab" data-testid="headers-tab">
              <Section title={t("general")}>
                <KeyValues pairs={general} />
              </Section>
              <Section title={t("requestHeaders")}>
                <p className="body-note">{t("noHeaders")}</p>
              </Section>
            </div>
          ),
          timing: (
            <TimingView
              timing={{ source: "events", phases: [] }}
              startOffsetMs={row.startMono - archive.model.minMono}
              totalMs={row.durationMs}
              pending={stream.closeMono === undefined}
            />
          ),
          initiator: <InitiatorTab archive={archive} connection={connection} events={openEvents} />
        }}
      />
    </section>
  );
}

/** The details pane under the Network table: a request or a socket. */
export function NetworkDetails({ row }: { row: NetworkRow }) {
  const archive = usePlayerState((state) => state.archive);

  if (!archive) {
    return null;
  }

  return row.kind === "http" ? (
    <RequestDetails row={row} archive={archive} />
  ) : (
    <SocketDetails row={row} archive={archive} />
  );
}
