import { useMemo, type ReactNode } from "react";

import type { WebBlackboxEvent } from "@webblackbox/protocol";
import {
  maskSensitiveUrl,
  readRequestConnection,
  readRequestTiming,
  type NetworkWaterfallEntry,
  type RequestConnectionInfo,
  type RequestTiming
} from "@webblackbox/player-sdk";

import { describeEventRow } from "../../../core/event-row.js";
import { formatOffset } from "../../../core/format.js";
import { describeNetworkStatus } from "../../../lib/network-view.js";
import { useController, useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import { useFeatureI18n } from "../messages.js";
import { useFeatureSlice } from "../slice.js";
import {
  requestBodyAvailability,
  responseBodyAvailability,
  skipReasonText,
  type BodyAvailability
} from "./availability.js";
import { decodeBody, decodeText, parseFormPairs, queryPairs } from "./body.js";
import { BodyViewer } from "./body-viewer.js";
import { networkMessages } from "./messages.js";
import { networkSlice } from "./slice.js";
import { useBlob } from "./use-archive-data.js";

type Pair = readonly [string, ReactNode];

type KeyValuesProps = {
  pairs: readonly Pair[];
  testId?: string;
};

export function KeyValues({ pairs, testId }: KeyValuesProps) {
  return (
    <dl className="nkv" data-testid={testId}>
      {pairs.map(([name, value], index) => (
        <div key={`${name}-${index}`} className="nkv-row">
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ndsec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** The events with these ids from the archive model (normalized playback times). */
export function useModelEvents(
  archive: LoadedArchive,
  eventIds: readonly string[]
): WebBlackboxEvent[] {
  return useMemo(
    () =>
      eventIds
        .map((id) => archive.model.eventById.get(id))
        .filter((event): event is WebBlackboxEvent => event !== undefined),
    [archive, eventIds]
  );
}

export function useConnection(events: WebBlackboxEvent[]): RequestConnectionInfo {
  return useMemo(() => readRequestConnection(events), [events]);
}

function sortedHeaders(headers: Record<string, string>): Pair[] {
  return Object.entries(headers).sort(([left], [right]) => left.localeCompare(right));
}

function when(condition: unknown, pair: Pair): Pair[] {
  return condition ? [pair] : [];
}

export function HeadersTab({
  entry,
  connection
}: {
  entry: NetworkWaterfallEntry;
  connection: RequestConnectionInfo;
}) {
  const t = useFeatureI18n(networkMessages);
  const locale = usePlayerState((state) => state.locale);
  const i18n = useI18n();
  const masked = maskSensitiveUrl(entry.url);
  const general: Pair[] = [
    [t("field_url"), <span className="mono">{masked.url}</span>],
    [t("field_method"), entry.method.toUpperCase()],
    [t("field_status"), describeNetworkStatus(entry, locale)],
    ...when(connection.remoteAddress, [t("field_remoteAddress"), connection.remoteAddress]),
    ...when(connection.protocol, [t("field_protocol"), connection.protocol]),
    ...when(connection.resourceType, [t("field_resourceType"), connection.resourceType]),
    ...when(entry.mimeType, [t("field_mime"), entry.mimeType]),
    ...when(entry.fromCache, [
      t("field_servedFrom"),
      entry.fromCache ? i18n.messages.networkCacheSources[entry.fromCache] : ""
    ]),
    ...when(entry.errorText, [t("field_error"), entry.errorText]),
    [t("field_requestId"), <span className="mono">{entry.reqId}</span>]
  ];
  const response = sortedHeaders(entry.responseHeaders);
  const request = sortedHeaders(entry.requestHeaders);

  return (
    <div className="ndtab" data-testid="headers-tab">
      <Section title={t("general")}>
        <KeyValues pairs={general} />
      </Section>
      <Section title={t("responseHeaders")}>
        {response.length > 0 ? (
          <KeyValues pairs={response} testId="response-headers" />
        ) : (
          <p className="nbody-note">{t("noHeaders")}</p>
        )}
      </Section>
      <Section title={t("requestHeaders")}>
        {request.length > 0 ? (
          <KeyValues pairs={request} testId="request-headers" />
        ) : (
          <p className="nbody-note">{t("noHeaders")}</p>
        )}
      </Section>
    </div>
  );
}

/** "Not captured — too large (5.0 MB, limit 1.0 MB)" or why there is no body. */
export function AvailabilityNote({
  availability,
  mime,
  noneText,
  testId
}: {
  availability: Exclude<BodyAvailability, { state: "captured" }>;
  mime?: string;
  noneText: string;
  testId: string;
}) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();

  if (availability.state === "skipped") {
    return (
      <p className="nnotice warn" data-testid={testId} data-reason={availability.skip.reason}>
        {t("notCapturedLine", {
          reason: skipReasonText(availability.skip, t, i18n.formatByteSize, mime)
        })}
      </p>
    );
  }

  return (
    <p className="nbody-note" data-testid={testId} data-reason={availability.state}>
      {availability.state === "missing" ? t("bodyMissing") : noneText}
    </p>
  );
}

export function PayloadTab({ entry }: { entry: NetworkWaterfallEntry }) {
  const t = useFeatureI18n(networkMessages);
  const maskSecrets = useFeatureSlice(networkSlice, (slice) => slice.maskSecrets);
  const query = queryPairs(maskSecrets ? maskSensitiveUrl(entry.url).url : entry.url);
  const availability = requestBodyAvailability(entry);
  const contentType =
    Object.entries(entry.requestHeaders).find(
      ([name]) => name.toLowerCase() === "content-type"
    )?.[1] ?? "";
  const body = entry.requestBodyText ?? "";
  const isForm = contentType.includes("x-www-form-urlencoded");
  const content = useMemo(() => decodeText(body), [body]);

  return (
    <div className="ndtab" data-testid="payload-tab">
      {query.length > 0 ? (
        <Section title={t("queryParams")}>
          <KeyValues pairs={query} testId="query-params" />
        </Section>
      ) : null}
      <Section title={isForm ? t("formData") : t("requestBody")}>
        {availability.state === "captured" ? (
          <>
            {availability.truncated ? (
              <p className="nnotice warn" data-testid="request-body-cut">
                {t("requestBodyCut")}
              </p>
            ) : null}
            {isForm ? <KeyValues pairs={parseFormPairs(body)} testId="form-data" /> : null}
            <BodyViewer content={content} testId="request-body" />
          </>
        ) : (
          <AvailabilityNote
            availability={availability}
            noneText={t("noPayload")}
            testId="request-body-note"
          />
        )}
      </Section>
    </div>
  );
}

export function ResponseTab({ entry }: { entry: NetworkWaterfallEntry }) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const availability = responseBodyAvailability(entry);
  const blob = useBlob(availability.state === "captured" ? entry.responseBodyHash : undefined);
  const content = useMemo(
    () =>
      blob?.status === "ready" && blob.value
        ? decodeBody(blob.value.bytes, entry.mimeType ?? blob.value.mime)
        : null,
    [blob, entry.mimeType]
  );

  if (availability.state !== "captured") {
    return (
      <div className="ndtab" data-testid="response-tab">
        <AvailabilityNote
          availability={availability}
          mime={entry.mimeType}
          noneText={t("bodyNone")}
          testId="response-body-note"
        />
      </div>
    );
  }

  const keptSize = i18n.formatByteSize(entry.responseBodySize ?? 0);

  return (
    <div className="ndtab ndtab-fill" data-testid="response-tab">
      {availability.truncated ? (
        <p className="nnotice warn" data-testid="response-body-cut">
          <span className="ncut">{t("cutBadge", { size: keptSize })}</span>{" "}
          {t("cutNote", { size: keptSize })}
        </p>
      ) : null}
      {blob === null || blob.status === "loading" ? (
        <p className="nbody-note">{t("bodyLoading")}</p>
      ) : blob.status === "error" ? (
        <p className="nnotice bad" data-testid="response-body-error">
          {t("bodyLoadFailed", { error: blob.message })}
        </p>
      ) : content ? (
        <BodyViewer content={content} testId="response-body" />
      ) : (
        <p className="nbody-note" data-testid="response-body-note" data-reason="missing">
          {t("bodyMissing")}
        </p>
      )}
    </div>
  );
}

export function TimingView({
  timing,
  startOffsetMs,
  totalMs,
  pending
}: {
  timing: RequestTiming;
  startOffsetMs: number;
  totalMs: number;
  pending: boolean;
}) {
  const t = useFeatureI18n(networkMessages);
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const span = Math.max(
    totalMs,
    ...timing.phases.map((phase) => phase.startMs + phase.durationMs),
    1
  );
  const ms = (value: number) => i18n.formatMilliseconds(value, { fractionDigits: 1 });

  return (
    <div className="ndtab" data-testid="timing-tab">
      <p className="muted">{t("timingStarted", { time: formatOffset(startOffsetMs, locale) })}</p>
      {timing.phases.length === 0 ? (
        <p className="nbody-note">{pending ? t("timingPending") : t("timingNone")}</p>
      ) : (
        <ul className="nphases" aria-label={t("timingLabel")}>
          {timing.phases.map((phase) => (
            <li
              key={phase.name}
              className={`nphase phase-${phase.name}`}
              data-testid="timing-phase"
            >
              <span className="nphase-name">{t(`phase_${phase.name}`)}</span>
              <span className="nphase-track" aria-hidden="true">
                <i
                  style={{
                    left: `${(phase.startMs / span) * 100}%`,
                    width: `${Math.max(0.5, (phase.durationMs / span) * 100)}%`
                  }}
                />
              </span>
              <span className="nphase-ms mono">{ms(phase.durationMs)}</span>
            </li>
          ))}
          <li className="nphase nphase-total">
            <span className="nphase-name">{t("timingTotal")}</span>
            <span className="nphase-track" />
            <span className="nphase-ms mono">{ms(totalMs)}</span>
          </li>
        </ul>
      )}
      {timing.source === "events" && timing.phases.length > 0 ? (
        <p className="muted nsmall">{t("timingFromEvents")}</p>
      ) : null}
    </div>
  );
}

export function RequestTimingTab({
  entry,
  events,
  minMono
}: {
  entry: NetworkWaterfallEntry;
  events: WebBlackboxEvent[];
  minMono: number;
}) {
  const timing = useMemo(() => readRequestTiming(events), [events]);

  return (
    <TimingView
      timing={timing}
      startOffsetMs={entry.startMono - minMono}
      totalMs={entry.durationMs}
      pending={entry.pending === true}
    />
  );
}

function frameLocation(url: string, line?: number, column?: number): string {
  return `${url}${line !== undefined ? `:${line + 1}` : ""}${column !== undefined ? `:${column + 1}` : ""}`;
}

export function InitiatorTab({
  archive,
  actionId,
  connection,
  events
}: {
  archive: LoadedArchive;
  actionId?: string;
  connection: RequestConnectionInfo;
  events: WebBlackboxEvent[];
}) {
  const t = useFeatureI18n(networkMessages);
  const controller = useController();
  const locale = usePlayerState((state) => state.locale);
  const action = actionId
    ? archive.model.actionTimeline.find((entry) => entry.actId === actionId)
    : undefined;
  const trigger = action ? archive.model.eventById.get(action.triggerEventId) : undefined;
  const initiator = connection.initiator;
  const offset = (mono: number) => formatOffset(mono - archive.model.minMono, locale);

  return (
    <div className="ndtab" data-testid="initiator-tab">
      {action ? (
        <Section title={t("initiatorAction")}>
          <p className="ninitiator-action">
            <span className="mono muted">{offset(action.startMono)}</span>{" "}
            <span className="mono">{action.actId}</span>{" "}
            {trigger ? describeEventRow(trigger, archive.model).primary : null}{" "}
            <button
              type="button"
              className="btn small"
              onClick={() => controller.select({ kind: "action", id: action.actId })}
              data-testid="go-to-action"
            >
              {t("goToAction")}
            </button>
          </p>
        </Section>
      ) : null}
      {initiator ? (
        <Section title={t("initiatorType")}>
          <KeyValues
            pairs={[
              [t("initiatorType"), initiator.type],
              ...when(initiator.url, [
                t("initiatorUrl"),
                <span className="mono">
                  {frameLocation(initiator.url ?? "", initiator.lineNumber)}
                </span>
              ]),
              ...when(connection.documentUrl, [
                t("initiatorDocument"),
                <span className="mono">{connection.documentUrl}</span>
              ])
            ]}
          />
          {connection.hasUserGesture ? <p className="muted">{t("userGesture")}</p> : null}
          {initiator.frames.length > 0 ? (
            <ol className="nstack mono" aria-label={t("initiatorStack")}>
              {initiator.frames.map((frame, index) => (
                <li key={index}>
                  <b>{frame.functionName || t("anonymousFunction")}</b>{" "}
                  {frameLocation(frame.url, frame.lineNumber, frame.columnNumber)}
                </li>
              ))}
            </ol>
          ) : null}
        </Section>
      ) : null}
      {!action && !initiator ? <p className="nbody-note">{t("noInitiator")}</p> : null}
      <Section title={t("linkedEvents")}>
        <ul className="nlinked" data-testid="linked-events">
          {events.map((event) => (
            <li key={event.id}>
              <button type="button" className="nlink" onClick={() => controller.selectEvent(event)}>
                <span className="mono muted">{offset(event.mono)}</span>{" "}
                <span className="mono">{event.type}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
