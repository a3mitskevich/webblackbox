import {
  extractRequestId,
  type WebBlackboxEvent,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import { lowerBoundEventMono, upperBoundEventMono } from "./event-order.js";
import { isErrorEvent } from "./event-query.js";
import type { WebBlackboxPlayer } from "./index.js";
import type {
  ActionSpan,
  ActionTimelineEntry,
  NetworkWaterfallEntry,
  PlayerDerivedView,
  ReplayDiagnosticEntry
} from "./types.js";
import { asNumber, asRecord, asString, isNonEmptyString, roundTo } from "./value-readers.js";

const ACTION_TRIGGER_TYPES = new Set<WebBlackboxEventType>([
  "user.click",
  "user.dblclick",
  "user.contextmenu",
  "user.auxclick",
  "user.drag.end",
  "user.keydown",
  "user.input",
  "user.submit",
  "user.marker",
  "nav.commit"
]);

const DEFAULT_ACTION_WINDOW_MS = 1500;
const DEFAULT_TIMELINE_SCREENSHOT_LOOKAHEAD_MS = 2000;
const DEFAULT_TIMELINE_REQUEST_LIMIT = 5;
const DEFAULT_TIMELINE_ERROR_LIMIT = 5;

export function deriveActionView(scoped: WebBlackboxEvent[]): PlayerDerivedView {
  const explicitSpans = new Map<string, ActionSpan>();
  const derivedSpans: ActionSpan[] = [];
  let openDerivedSpan: ActionSpan | null = null;

  for (const event of scoped) {
    if (event.ref?.act) {
      const current =
        explicitSpans.get(event.ref.act) ?? createActionSpan(event.ref.act, event.id, event.mono);
      current.endMono = Math.max(current.endMono, event.mono);
      current.eventIds.push(event.id);
      updateActionStats(current, event);
      explicitSpans.set(event.ref.act, current);
      continue;
    }

    if (ACTION_TRIGGER_TYPES.has(event.type)) {
      if (openDerivedSpan) {
        derivedSpans.push(openDerivedSpan);
      }

      openDerivedSpan = createActionSpan(`derived:${event.id}`, event.id, event.mono);
      openDerivedSpan.eventIds.push(event.id);
      updateActionStats(openDerivedSpan, event);
      continue;
    }

    if (!openDerivedSpan) {
      continue;
    }

    if (event.mono - openDerivedSpan.startMono > DEFAULT_ACTION_WINDOW_MS) {
      derivedSpans.push(openDerivedSpan);
      openDerivedSpan = null;
      continue;
    }

    openDerivedSpan.eventIds.push(event.id);
    openDerivedSpan.endMono = event.mono;
    updateActionStats(openDerivedSpan, event);
  }

  if (openDerivedSpan) {
    derivedSpans.push(openDerivedSpan);
  }

  const actionSpans = [...explicitSpans.values(), ...derivedSpans].sort(
    (left, right) => left.startMono - right.startMono
  );

  const totals = {
    events: scoped.length,
    errors: scoped.filter(isErrorEvent).length,
    requests: scoped.filter((event) => event.type === "network.request").length
  };

  const derived = {
    actionSpans,
    totals
  };

  return derived;
}

export function buildActionTimeline(
  player: Pick<WebBlackboxPlayer, "buildDerived" | "query" | "getNetworkWaterfall">,
  options: NonNullable<Parameters<WebBlackboxPlayer["getActionTimeline"]>[0]>
): ActionTimelineEntry[] {
  const { range } = options;
  const limit = Math.max(1, options.limit ?? Number.POSITIVE_INFINITY);
  const screenshotLookaheadMs = Math.max(
    0,
    options.screenshotLookaheadMs ?? DEFAULT_TIMELINE_SCREENSHOT_LOOKAHEAD_MS
  );
  const requestLimit = Math.max(1, options.requestLimit ?? DEFAULT_TIMELINE_REQUEST_LIMIT);
  const errorLimit = Math.max(1, options.errorLimit ?? DEFAULT_TIMELINE_ERROR_LIMIT);
  const derived = options.derived ?? player.buildDerived(range);
  const scopedEvents = player.query({ range });
  const scopedById = new Map(scopedEvents.map((event) => [event.id, event]));
  const requestById = new Map(
    player.getNetworkWaterfall(range).map((entry) => [entry.reqId, entry])
  );
  const screenshots = player.query({
    range,
    types: ["screen.screenshot"]
  });
  const errorEvents = scopedEvents.filter(isErrorEvent);

  return derived.actionSpans.slice(0, limit).map((span) => {
    const spanEvents = span.eventIds
      .map((eventId) => scopedById.get(eventId))
      .filter((event): event is WebBlackboxEvent => Boolean(event));
    const requestIds = [
      ...new Set(spanEvents.map((event) => extractRequestId(event)).filter(isNonEmptyString))
    ];
    const requests = requestIds
      .map((reqId) => requestById.get(reqId))
      .filter((entry): entry is NetworkWaterfallEntry => Boolean(entry))
      .sort((left, right) => left.startMono - right.startMono)
      .slice(0, requestLimit)
      .map((entry) => ({
        reqId: entry.reqId,
        method: entry.method,
        url: entry.url,
        status: typeof entry.status === "number" ? entry.status : null,
        failed: entry.failed,
        durationMs: roundTo(entry.durationMs, 2)
      }));
    const errors = findActionErrors(span, errorEvents, screenshotLookaheadMs, errorLimit);
    const triggerEvent = scopedById.get(span.triggerEventId);
    const screenshot = findActionScreenshot(span, screenshots, screenshotLookaheadMs);

    return {
      actId: span.actId,
      triggerEventId: span.triggerEventId,
      triggerType: triggerEvent?.type ?? null,
      startMono: span.startMono,
      endMono: span.endMono,
      durationMs: roundTo(span.endMono - span.startMono, 2),
      eventCount: span.eventIds.length,
      requestCount: span.requestCount,
      errorCount: span.errorCount,
      requests,
      errors,
      screenshot
    };
  });
}

export function buildReplayDiagnostics(
  player: Pick<WebBlackboxPlayer, "getActionTimeline" | "getNetworkWaterfall">,
  options: NonNullable<Parameters<WebBlackboxPlayer["getReplayDiagnostics"]>[0]>
): ReplayDiagnosticEntry[] {
  const limit = Math.max(1, options.limit ?? Number.POSITIVE_INFINITY);
  const actions = (
    options.actions ??
    player.getActionTimeline({
      range: options.range,
      limit
    })
  ).slice(0, limit);
  const waterfall = options.waterfall ?? player.getNetworkWaterfall(options.range);
  const requestById = new Map(waterfall.map((entry) => [entry.reqId, entry]));

  return actions.map((action) => {
    const requestResponseDiffs = action.requests.map((request) => {
      const full = requestById.get(request.reqId);

      return {
        reqId: request.reqId,
        method: request.method,
        url: request.url,
        capturedStatus: request.status,
        failed: request.failed,
        hasRequestBody: Boolean(full?.requestBodyText),
        hasResponseBody: Boolean(full?.responseBodyHash),
        responseBodySize: full?.responseBodySize ?? null
      };
    });
    const errorMessages = action.errors
      .map((error) => error.message)
      .filter((message): message is string => Boolean(message));
    const causeChain = buildReplayCauseChain(action, requestResponseDiffs, errorMessages);

    return {
      actId: action.actId,
      confidence: resolveReplayConfidence(action, requestResponseDiffs),
      triggerEventId: action.triggerEventId,
      triggerType: action.triggerType,
      causeChain,
      requestResponseDiffs,
      errorMessages,
      screenshotEventId: action.screenshot?.eventId ?? null
    };
  });
}

function readEventMessage(event: WebBlackboxEvent): string | null {
  const payload = asRecord(event.data);
  const message =
    asString(payload?.message) ??
    asString(payload?.text) ??
    asString(payload?.errorText) ??
    asString(payload?.reason);

  return message ? compactText(message, 300) : null;
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function findActionErrors(
  span: ActionSpan,
  errorEvents: WebBlackboxEvent[],
  lookaheadMs: number,
  limit: number
): ActionTimelineEntry["errors"] {
  const errors: ActionTimelineEntry["errors"] = [];
  const endMono = span.endMono + lookaheadMs;

  for (
    let index = lowerBoundEventMono(errorEvents, span.startMono);
    index < errorEvents.length;
    index += 1
  ) {
    const event = errorEvents[index];

    if (!event) {
      continue;
    }

    if (event.mono > endMono || errors.length >= limit) {
      break;
    }

    errors.push({
      eventId: event.id,
      type: event.type,
      mono: event.mono,
      message: readEventMessage(event)
    });
  }

  return errors;
}

function findActionScreenshot(
  span: ActionSpan,
  screenshots: WebBlackboxEvent[],
  lookaheadMs: number
): ActionTimelineEntry["screenshot"] {
  const firstInSpan = lowerBoundEventMono(screenshots, span.startMono);
  const firstAfterSpan = upperBoundEventMono(screenshots, span.endMono);
  const inSpan = firstAfterSpan > firstInSpan ? screenshots[firstAfterSpan - 1] : undefined;
  const afterSpan = screenshots[firstAfterSpan];
  const chosen =
    inSpan ?? (afterSpan && afterSpan.mono <= span.endMono + lookaheadMs ? afterSpan : undefined);

  if (!chosen) {
    return null;
  }

  const payload = asRecord(chosen.data);
  return {
    eventId: chosen.id,
    mono: chosen.mono,
    shotId: asString(payload?.shotId) ?? null,
    reason: asString(payload?.reason) ?? null,
    format: asString(payload?.format) ?? null,
    size: asNumber(payload?.size) ?? null
  };
}

function buildReplayCauseChain(
  action: ActionTimelineEntry,
  diffs: ReplayDiagnosticEntry["requestResponseDiffs"],
  errorMessages: string[]
): string[] {
  const chain = [`trigger:${action.triggerType ?? "unknown"}:${action.triggerEventId}`];

  for (const diff of diffs) {
    const status = diff.failed ? "failed" : (diff.capturedStatus ?? "pending");
    const bodyState = diff.hasResponseBody ? "response-body" : "no-response-body";
    chain.push(`request:${diff.method}:${status}:${bodyState}:${diff.reqId}`);
  }

  for (const message of errorMessages.slice(0, 3)) {
    chain.push(`error:${message}`);
  }

  if (action.screenshot) {
    chain.push(`screenshot:${action.screenshot.eventId}`);
  }

  return chain;
}

function resolveReplayConfidence(
  action: ActionTimelineEntry,
  diffs: ReplayDiagnosticEntry["requestResponseDiffs"]
): ReplayDiagnosticEntry["confidence"] {
  const hasEvidence = diffs.length > 0 || action.errors.length > 0 || Boolean(action.screenshot);
  const hasRichNetwork = diffs.some((diff) => diff.hasResponseBody || diff.hasRequestBody);

  if (action.screenshot && (hasRichNetwork || action.errors.length > 0)) {
    return "high";
  }

  if (hasEvidence) {
    return "medium";
  }

  return "low";
}

function createActionSpan(actId: string, triggerEventId: string, mono: number): ActionSpan {
  return {
    actId,
    startMono: mono,
    endMono: mono,
    eventIds: [],
    triggerEventId,
    requestCount: 0,
    errorCount: 0
  };
}

function updateActionStats(span: ActionSpan, event: WebBlackboxEvent): void {
  if (event.type === "network.request") {
    span.requestCount += 1;
  }

  if (isErrorEvent(event)) {
    span.errorCount += 1;
  }
}
