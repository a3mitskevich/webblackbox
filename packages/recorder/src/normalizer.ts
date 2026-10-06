import {
  extractRequestIdFromPayload,
  isBodySkipReason,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import { CdpCacheTracker, normalizeCdpNetworkPayload } from "./cdp-network.js";
import { normalizeCdpExceptionPayload } from "./cdp-runtime.js";
import {
  normalizeCdpConsolePayload,
  normalizeContentConsolePayload,
  type ConsoleDetail
} from "./console-normalizer.js";
import {
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  compactText,
  normalizeHeaderRecord,
  sanitizeOptionalUrl,
  stripUndefined
} from "./normalizer-utils.js";
import { normalizeScriptSourceMapPayload } from "./script-source-map.js";
import { normalizeTabsContextPayload } from "./tabs-context.js";
import { recordedUrl } from "./url-recording.js";
import type { EventNormalizer, RawRecorderEvent } from "./types.js";

const CDP_EVENT_MAP: Record<string, WebBlackboxEventType> = {
  "Network.requestWillBeSent": "network.request",
  "Network.responseReceived": "network.response",
  "Network.loadingFinished": "network.finished",
  "Network.loadingFailed": "network.failed",
  "Network.webSocketCreated": "network.ws.open",
  "Network.webSocketFrameReceived": "network.ws.frame",
  "Network.webSocketFrameSent": "network.ws.frame",
  "Network.webSocketClosed": "network.ws.close",
  "Network.eventSourceMessageReceived": "network.sse.message",
  "Runtime.consoleAPICalled": "console.entry",
  "Log.entryAdded": "console.entry",
  "Runtime.exceptionThrown": "error.exception",
  "Page.frameNavigated": "nav.commit",
  "Page.navigatedWithinDocument": "nav.hash"
};

const CONTENT_EVENT_MAP: Record<string, WebBlackboxEventType> = {
  click: "user.click",
  dblclick: "user.dblclick",
  keydown: "user.keydown",
  input: "user.input",
  submit: "user.submit",
  scroll: "user.scroll",
  mousemove: "user.mousemove",
  pointerdown: "user.pointerdown",
  pointerup: "user.pointerup",
  contextmenu: "user.contextmenu",
  auxclick: "user.auxclick",
  clickReaction: "user.click.reaction",
  dragStart: "user.drag.start",
  dragEnd: "user.drag.end",
  selection: "user.selection",
  wheel: "user.wheel",
  hover: "user.hover",
  focus: "user.focus",
  blur: "user.blur",
  marker: "user.marker",
  visibilitychange: "user.visibility",
  resize: "user.resize",
  mutation: "dom.mutation.batch",
  rrweb: "dom.rrweb.event",
  snapshot: "dom.snapshot",
  screenshot: "screen.screenshot",
  console: "console.entry",
  pageError: "error.exception",
  unhandledrejection: "error.unhandledrejection",
  resourceError: "error.resource",
  longtask: "perf.longtask",
  vitals: "perf.vitals",
  privacyViolation: "privacy.violation",
  localStorageOp: "storage.local.op",
  localStorageSnapshot: "storage.local.snapshot",
  sessionStorageOp: "storage.session.op",
  indexedDbOp: "storage.idb.op",
  indexedDbSnapshot: "storage.idb.snapshot",
  cookieSnapshot: "storage.cookie.snapshot",
  sse: "network.sse.message"
};
/** Raw type of script → source map records from the debugger (system) or the lite scanner. */
const SCRIPT_RAW_TYPE = "script";

/** Host-side raw type of a body the policy asked for but the host could not keep. */
export const BODY_SKIPPED_RAW_TYPE = "cdp.network.body.skipped";
const MAX_BODY_SKIP_DETAIL_CHARS = 200;
let fallbackRequestSequence = 0;

export type DefaultEventNormalizerOptions = {
  /** Console/exception text detail; the recorder uses `full` under the `console: allow` policy. */
  consoleDetail?: ConsoleDetail;
};

export class DefaultEventNormalizer implements EventNormalizer {
  private readonly consoleDetail: ConsoleDetail;

  private readonly cacheTracker = new CdpCacheTracker();

  public constructor(options: DefaultEventNormalizerOptions = {}) {
    this.consoleDetail = options.consoleDetail ?? "compact";
  }

  public normalize(
    input: RawRecorderEvent
  ): { eventType: WebBlackboxEventType; payload: unknown } | null {
    if (input.rawType === SCRIPT_RAW_TYPE && input.source !== "cdp") {
      const payload = normalizeScriptSourceMapPayload(input.payload);

      return payload ? { eventType: "sys.script", payload } : null;
    }

    if (input.source === "cdp") {
      return this.normalizeCdp(input);
    }

    if (input.source === "content") {
      if (input.rawType === "console") {
        return {
          eventType: "console.entry",
          payload: normalizeContentConsolePayload(input.payload, this.consoleDetail)
        };
      }

      if (input.rawType === "fetch" || input.rawType === "xhr") {
        const payload = asRecord(input.payload);
        const phase = asString(payload?.phase);

        if (phase === "end") {
          return {
            eventType: "network.response",
            payload: normalizeContentNetworkResponsePayload(payload)
          };
        }

        return {
          eventType: "network.request",
          payload: normalizeContentNetworkRequestPayload(payload)
        };
      }

      if (input.rawType === "fetchError") {
        return {
          eventType: "network.failed",
          payload: normalizeContentNetworkFailedPayload(asRecord(input.payload))
        };
      }

      if (input.rawType === "networkBody") {
        return {
          eventType: "network.body",
          payload: normalizeContentNetworkBodyPayload(asRecord(input.payload))
        };
      }

      const eventType = CONTENT_EVENT_MAP[input.rawType];

      if (!eventType) {
        return null;
      }

      return {
        eventType,
        payload: input.payload
      };
    }

    if (input.rawType === "tabs.snapshot" || input.rawType === "tabs.change") {
      return normalizeTabsContextEvent(input.rawType, input.payload);
    }

    if (input.rawType === BODY_SKIPPED_RAW_TYPE) {
      const payload = normalizeBodySkippedPayload(asRecord(input.payload));
      return payload ? { eventType: "network.body.skipped", payload } : null;
    }

    const normalized = tryNormalizeSystemEvent(input.rawType);

    if (!normalized) {
      return null;
    }

    return {
      eventType: normalized,
      payload: input.payload
    };
  }

  private normalizeCdp(
    input: RawRecorderEvent
  ): { eventType: WebBlackboxEventType; payload: unknown } | null {
    if (input.rawType === "Network.requestServedFromCache") {
      this.cacheTracker.remember(input.cdpSessionId, input.payload);
      return null;
    }

    const eventType = CDP_EVENT_MAP[input.rawType];

    if (!eventType) {
      return null;
    }

    if (eventType.startsWith("network.")) {
      return {
        eventType,
        payload: this.cacheTracker.annotate(
          input.rawType,
          input.cdpSessionId,
          normalizeCdpNetworkPayload(input.rawType, input.payload)
        )
      };
    }

    return {
      eventType,
      payload: normalizeCdpPayload(eventType, input.rawType, input.payload, this.consoleDetail)
    };
  }
}

/** Parallel-tabs context from the extension; malformed payloads are dropped. */
function normalizeTabsContextEvent(
  rawType: "tabs.snapshot" | "tabs.change",
  payload: unknown
): { eventType: WebBlackboxEventType; payload: unknown } | null {
  const eventType = rawType === "tabs.snapshot" ? "meta.tabs.snapshot" : "meta.tabs.change";
  const normalized = normalizeTabsContextPayload(eventType, payload);

  return normalized ? { eventType, payload: normalized } : null;
}

function normalizeCdpPayload(
  eventType: WebBlackboxEventType,
  rawType: string,
  payload: unknown,
  consoleDetail: ConsoleDetail
): unknown {
  if (eventType === "console.entry") {
    return normalizeCdpConsolePayload(rawType, payload, consoleDetail);
  }

  if (eventType === "error.exception") {
    return normalizeCdpExceptionPayload(payload, consoleDetail);
  }

  return payload;
}

function normalizeContentNetworkRequestPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const method = (asString(payload?.method) ?? "GET").toUpperCase();
  const url = recordedUrl(asString(payload?.url) ?? "unknown://request");
  const reqId = readRequestId(payload) ?? buildFallbackReqId(method, url);

  return stripUndefined({
    reqId,
    requestId: reqId,
    method,
    url,
    headers: normalizeHeaderRecord(payload?.headers),
    postDataSize:
      asFiniteNumber(payload?.postDataSize) ??
      asFiniteNumber(payload?.bodyLength) ??
      asFiniteNumber(payload?.size) ??
      undefined
  });
}

function normalizeContentNetworkResponsePayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const method = asString(payload?.method);
  const url = asString(payload?.url);
  const sanitizedUrl = url ? recordedUrl(url) : undefined;
  const reqId =
    readRequestId(payload) ??
    buildFallbackReqId(method ?? "GET", sanitizedUrl ?? "unknown://request");

  return stripUndefined({
    reqId,
    requestId: reqId,
    method: method ? method.toUpperCase() : undefined,
    url: sanitizedUrl,
    status: asFiniteNumber(payload?.status) ?? undefined,
    statusText: asString(payload?.statusText) ?? undefined,
    mimeType: asString(payload?.mimeType) ?? undefined,
    headers: normalizeHeaderRecord(payload?.headers),
    encodedDataLength:
      asFiniteNumber(payload?.encodedDataLength) ??
      asFiniteNumber(payload?.bodyLength) ??
      asFiniteNumber(payload?.size) ??
      undefined,
    duration: asFiniteNumber(payload?.duration) ?? undefined,
    ok: asBoolean(payload?.ok),
    redirected: asBoolean(payload?.redirected),
    responseUrl: sanitizeOptionalUrl(asString(payload?.responseUrl)),
    failed: asBoolean(payload?.failed)
  });
}

function normalizeContentNetworkFailedPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const method = asString(payload?.method);
  const url = asString(payload?.url);
  const sanitizedUrl = url ? recordedUrl(url) : undefined;
  const reqId =
    readRequestId(payload) ??
    buildFallbackReqId(method ?? "GET", sanitizedUrl ?? "unknown://request");

  return stripUndefined({
    reqId,
    requestId: reqId,
    method: method ? method.toUpperCase() : undefined,
    url: sanitizedUrl,
    duration: asFiniteNumber(payload?.duration) ?? undefined,
    message: asString(payload?.message) ?? undefined,
    errorText: asString(payload?.errorText) ?? asString(payload?.message) ?? undefined
  });
}

function normalizeContentNetworkBodyPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> {
  const reqId =
    readRequestId(payload) ??
    buildFallbackReqId("GET", sanitizeOptionalUrl(asString(payload?.url)) ?? "unknown://request");

  return stripUndefined({
    reqId,
    requestId: reqId,
    contentHash: asString(payload?.contentHash) ?? asString(payload?.hash) ?? undefined,
    mimeType: asString(payload?.mimeType) ?? undefined,
    size: asFiniteNumber(payload?.size) ?? undefined,
    sampledSize: asFiniteNumber(payload?.sampledSize) ?? undefined,
    redacted: asBoolean(payload?.redacted),
    truncated: asBoolean(payload?.truncated)
  });
}

function normalizeBodySkippedPayload(
  payload: Record<string, unknown> | null
): Record<string, unknown> | null {
  const reqId = readRequestId(payload);
  const reason = payload?.reason;

  if (!reqId || !isBodySkipReason(reason)) {
    return null;
  }

  const size = asFiniteNumber(payload?.size);
  const limit = asFiniteNumber(payload?.limit);
  const detail = asString(payload?.detail);

  return stripUndefined({
    reqId,
    requestId: reqId,
    side: payload?.side === "request" ? "request" : "response",
    reason,
    mimeType: asString(payload?.mimeType) ?? undefined,
    size: size !== null && size >= 0 ? size : undefined,
    limit: limit !== null && limit >= 0 ? limit : undefined,
    detail: detail ? compactText(detail, MAX_BODY_SKIP_DETAIL_CHARS) : undefined
  });
}

function readRequestId(payload: Record<string, unknown> | null): string | null {
  return extractRequestIdFromPayload(payload);
}

function buildFallbackReqId(method: string, url: string): string {
  fallbackRequestSequence = (fallbackRequestSequence + 1) >>> 0;
  return `content-${method.toUpperCase()}-${compactText(url, 120)}-${fallbackRequestSequence.toString(36)}`;
}

function tryNormalizeSystemEvent(rawType: string): WebBlackboxEventType | null {
  if (rawType === "session-start") {
    return "meta.session.start";
  }

  if (rawType === "session-end") {
    return "meta.session.end";
  }

  if (rawType === "notice") {
    return "sys.notice";
  }

  if (rawType === "debugger-attach") {
    return "sys.debugger.attach";
  }

  if (rawType === "debugger-detach") {
    return "sys.debugger.detach";
  }

  if (rawType === "config") {
    return "meta.config";
  }

  if (rawType === "privacyViolation") {
    return "privacy.violation";
  }

  if (rawType === "cdp.network.body") {
    return "network.body";
  }

  if (rawType === "cdp.screen.screenshot") {
    return "screen.screenshot";
  }

  if (rawType === "screen.recording.start") {
    return "screen.recording.start";
  }

  if (rawType === "screen.recording.chunk") {
    return "screen.recording.chunk";
  }

  if (rawType === "screen.recording.end") {
    return "screen.recording.end";
  }

  if (rawType === "screen.recording.error") {
    return "screen.recording.error";
  }

  if (rawType === "cdp.dom.snapshot") {
    return "dom.snapshot";
  }

  if (rawType === "cdp.storage.cookie.snapshot") {
    return "storage.cookie.snapshot";
  }

  if (rawType === "cdp.storage.local.snapshot") {
    return "storage.local.snapshot";
  }

  if (rawType === "cdp.storage.idb.snapshot") {
    return "storage.idb.snapshot";
  }

  if (rawType === "cdp.perf.trace") {
    return "perf.trace";
  }

  if (rawType === "cdp.perf.cpu.profile") {
    return "perf.cpu.profile";
  }

  if (rawType === "cdp.perf.heap.snapshot") {
    return "perf.heap.snapshot";
  }

  return null;
}
