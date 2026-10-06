import type { WebBlackboxEvent } from "@webblackbox/protocol";

/**
 * Details of one request for an inspector: the timing phases (from Chrome's ResourceTiming when
 * the archive has it), the initiator and connection facts, and a URL fit for display with secret
 * values hidden. Archive data is untrusted: every field is read defensively.
 */

export type RequestTimingPhaseName =
  | "queueing"
  | "stalled"
  | "proxy"
  | "dns"
  | "connect"
  | "ssl"
  | "send"
  | "wait"
  | "download";

export type RequestTimingPhase = {
  name: RequestTimingPhaseName;
  /** Offset from the request start, in ms. */
  startMs: number;
  durationMs: number;
};

export type RequestTiming = {
  /** `resource-timing`: Chrome's per-phase timing; `events`: request → response → end only. */
  source: "resource-timing" | "events";
  phases: RequestTimingPhase[];
  /** Request start → response headers. */
  waitingMs?: number;
};

export type RequestInitiatorFrame = {
  functionName: string;
  url: string;
  lineNumber?: number;
  columnNumber?: number;
};

export type RequestInitiator = {
  /** CDP initiator type: `parser`, `script`, `preload`, `preflight`, `other`, … */
  type: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  frames: RequestInitiatorFrame[];
};

export type RequestConnectionInfo = {
  /** CDP resource type: `Document`, `Fetch`, `XHR`, `Script`, … */
  resourceType?: string;
  /** `h2`, `http/1.1`, … */
  protocol?: string;
  remoteAddress?: string;
  documentUrl?: string;
  hasUserGesture?: boolean;
  initiator?: RequestInitiator;
};

export type MaskedUrl = {
  url: string;
  /**
   * Query or fragment parameters whose values were hidden (`access_token`, `signature`, …),
   * decoded and listed once, plus `URL_USERINFO_MARKER` when the authority's userinfo was hidden.
   */
  hiddenParams: string[];
};

/** Entry of `MaskedUrl.hiddenParams` for a hidden `user:password@` part of the URL authority. */
export const URL_USERINFO_MARKER = "userinfo";

const MAX_INITIATOR_FRAMES = 40;
/**
 * Parameter names whose values are secrets. Suffix and whole-name rules (`_key`, `^key$`, `otp`)
 * keep plain words (`keyword`, `monkey`, `spotprice`) visible.
 */
const SECRET_PARAM_PATTERN = new RegExp(
  [
    "token|secret|password|passwd|signature|credential|authoriz|bearer|jwt|session",
    "(?:api|access|private)[-_]?key|[-_]key$",
    "(?:^|[-_])[th]?otp(?:$|[-_])",
    "^auth$|^key$|^sig$|^code$|^pwd$|^sid$"
  ].join("|"),
  "i"
);
const HIDDEN_VALUE = "…";
/** `scheme://` or a scheme-relative `//`: an authority (with possible userinfo) follows. */
const AUTHORITY_START_PATTERN = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;
/**
 * A ResourceTiming `requestTime` this far before the request event belongs to an earlier load
 * (memory cache, service worker): its phases do not describe this request.
 */
const STALE_REQUEST_TIME_TOLERANCE_MS = 1;

/**
 * Timing of one request from its events (`getRequestEvents`): Chrome ResourceTiming phases when the
 * response carries `timing`, otherwise waiting (request → response) and download (response → end).
 */
export function readRequestTiming(events: readonly WebBlackboxEvent[]): RequestTiming {
  const requests = events.filter((event) => event.type === "network.request");
  const response = events.find((event) => event.type === "network.response");
  const end = events.find(
    (event) => event.type === "network.finished" || event.type === "network.failed"
  );
  const fromResourceTiming = readResourceTiming(
    findAnsweredRequest(requests, response),
    response,
    end
  );

  if (fromResourceTiming) {
    return fromResourceTiming;
  }

  const phases: RequestTimingPhase[] = [];
  const startMono = requests[0]?.mono ?? events[0]?.mono;

  if (startMono === undefined) {
    return { source: "events", phases };
  }

  const waitingMs = response ? Math.max(0, response.mono - startMono) : undefined;

  if (waitingMs !== undefined) {
    phases.push({ name: "wait", startMs: 0, durationMs: waitingMs });
  }

  if (response && end && end.mono >= response.mono) {
    phases.push({
      name: "download",
      startMs: waitingMs ?? 0,
      durationMs: end.mono - response.mono
    });
  }

  return { source: "events", phases, ...(waitingMs === undefined ? {} : { waitingMs }) };
}

/**
 * The request a response answers. A redirect chain repeats `network.request` per hop, and the
 * response's ResourceTiming belongs to the last hop sent before it.
 */
function findAnsweredRequest(
  requests: readonly WebBlackboxEvent[],
  response: WebBlackboxEvent | undefined
): WebBlackboxEvent | undefined {
  if (!response) {
    return requests[0];
  }

  return requests.findLast((request) => request.mono <= response.mono) ?? requests[0];
}

function readResourceTiming(
  request: WebBlackboxEvent | undefined,
  response: WebBlackboxEvent | undefined,
  end: WebBlackboxEvent | undefined
): RequestTiming | null {
  const timing = asRecord(asRecord(asRecord(response?.data)?.response)?.timing);
  const requestTime = asNumber(timing?.requestTime);

  if (!timing || requestTime === undefined) {
    return null;
  }

  const requestSeconds = asNumber(asRecord(request?.data)?.timestamp);
  const endSeconds = asNumber(asRecord(end?.data)?.timestamp);
  // ResourceTiming offsets count from `requestTime`; the request event may predate it (queueing).
  const offsetMs = requestSeconds !== undefined ? (requestTime - requestSeconds) * 1_000 : 0;

  if (offsetMs < -STALE_REQUEST_TIME_TOLERANCE_MS) {
    return null;
  }

  const base = Math.max(0, offsetMs);
  const at = (key: string): number | undefined => {
    const value = asNumber(timing[key]);
    return value !== undefined && value >= 0 ? value : undefined;
  };
  const phases: RequestTimingPhase[] = [];
  const push = (name: RequestTimingPhaseName, start?: number, finish?: number): void => {
    if (start !== undefined && finish !== undefined && finish >= start) {
      phases.push({ name, startMs: base + start, durationMs: finish - start });
    }
  };

  if (base > 0) {
    phases.push({ name: "queueing", startMs: 0, durationMs: base });
  }

  const sslStart = at("sslStart");
  const sendStart = at("sendStart");
  const sendEnd = at("sendEnd");
  const headersEnd = at("receiveHeadersEnd");
  const firstActivity = [at("proxyStart"), at("dnsStart"), at("connectStart"), sendStart].find(
    (value) => value !== undefined
  );

  push("stalled", 0, firstActivity);
  push("proxy", at("proxyStart"), at("proxyEnd"));
  push("dns", at("dnsStart"), at("dnsEnd"));
  push("connect", at("connectStart"), sslStart ?? at("connectEnd"));
  push("ssl", sslStart, at("sslEnd"));
  push("send", sendStart, sendEnd);
  push("wait", sendEnd, headersEnd);

  if (headersEnd !== undefined && endSeconds !== undefined) {
    push("download", headersEnd, Math.max(headersEnd, (endSeconds - requestTime) * 1_000));
  }

  return {
    source: "resource-timing",
    phases,
    ...(headersEnd === undefined ? {} : { waitingMs: base + headersEnd })
  };
}

/**
 * Resource type, protocol, remote address and initiator of a request (or of a WebSocket, from its
 * `network.ws.open` event).
 */
export function readRequestConnection(events: readonly WebBlackboxEvent[]): RequestConnectionInfo {
  const opener = events.find(
    (event) => event.type === "network.request" || event.type === "network.ws.open"
  );
  const openerData = asRecord(opener?.data);
  const responseData = asRecord(events.find((event) => event.type === "network.response")?.data);
  const response = asRecord(responseData?.response);
  const ip = asString(response?.remoteIPAddress);
  const port = asNumber(response?.remotePort);
  const initiator = readInitiator(openerData?.initiator);
  const hasUserGesture = openerData?.hasUserGesture;

  return {
    ...optional("resourceType", asString(openerData?.type) ?? asString(responseData?.type)),
    ...optional("protocol", asString(response?.protocol)),
    ...optional("remoteAddress", ip ? (port !== undefined ? `${ip}:${port}` : ip) : undefined),
    ...optional("documentUrl", asString(openerData?.documentURL)),
    ...(typeof hasUserGesture === "boolean" ? { hasUserGesture } : {}),
    ...(initiator ? { initiator } : {})
  };
}

function readInitiator(value: unknown): RequestInitiator | null {
  const initiator = asRecord(value);
  const type = asString(initiator?.type);

  if (!initiator || !type) {
    return null;
  }

  return {
    type,
    ...optional("url", asString(initiator.url)),
    ...optional("lineNumber", asNumber(initiator.lineNumber)),
    ...optional("columnNumber", asNumber(initiator.columnNumber)),
    frames: readCallFrames(asRecord(initiator.stack))
  };
}

/** Call frames of a CDP stack trace and its async parents, capped. */
function readCallFrames(stack: Record<string, unknown> | null): RequestInitiatorFrame[] {
  const frames: RequestInitiatorFrame[] = [];
  let current = stack;

  while (current && frames.length < MAX_INITIATOR_FRAMES) {
    const callFrames: unknown[] = Array.isArray(current.callFrames) ? current.callFrames : [];

    for (const raw of callFrames.slice(0, MAX_INITIATOR_FRAMES - frames.length)) {
      const frame = asRecord(raw);
      const url = typeof frame?.url === "string" ? frame.url : undefined;

      if (!frame || url === undefined) {
        continue;
      }

      frames.push({
        functionName: asString(frame.functionName) ?? "",
        url,
        ...optional("lineNumber", asNumber(frame.lineNumber)),
        ...optional("columnNumber", asNumber(frame.columnNumber))
      });
    }

    current = asRecord(current.parent);
  }

  return frames;
}

/**
 * The URL with secret values replaced by `…`: secret-looking parameters of the query and of the
 * fragment (OAuth implicit-flow tokens, hash-routed queries) and the authority's userinfo. Works on
 * the text, so relative URLs are masked too and everything but the hidden values stays
 * byte-identical (no re-encoding, no decoding).
 */
export function maskSensitiveUrl(url: string): MaskedUrl {
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const head = maskUserinfo(queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex));
  const query = queryIndex < 0 ? null : maskParams(beforeHash.slice(queryIndex + 1));
  const fragment = hashIndex < 0 ? null : maskParams(url.slice(hashIndex + 1));
  const hiddenParams = [
    ...new Set([...head.hidden, ...(query?.hidden ?? []), ...(fragment?.hidden ?? [])])
  ];

  if (hiddenParams.length === 0) {
    return { url, hiddenParams };
  }

  return {
    url: `${head.text}${query ? `?${query.text}` : ""}${fragment ? `#${fragment.text}` : ""}`,
    hiddenParams
  };
}

/** A URL part after masking, with the names of what it hides. */
type MaskedPart = { text: string; hidden: string[] };

/** Hides `user:password@` of an absolute or scheme-relative URL (the part before `?` and `#`). */
function maskUserinfo(head: string): MaskedPart {
  const authorityStart = AUTHORITY_START_PATTERN.exec(head)?.[0].length;

  if (authorityStart === undefined) {
    return { text: head, hidden: [] };
  }

  const pathStart = head.indexOf("/", authorityStart);
  const authority = head.slice(authorityStart, pathStart < 0 ? head.length : pathStart);
  // The last `@` ends the userinfo, as in the WHATWG URL parser.
  const at = authority.lastIndexOf("@");

  if (at <= 0) {
    return { text: head, hidden: [] };
  }

  return {
    text: `${head.slice(0, authorityStart)}${HIDDEN_VALUE}${head.slice(authorityStart + at)}`,
    hidden: [URL_USERINFO_MARKER]
  };
}

/**
 * Hides secret values of `name=value` pairs. `?` splits as well as `&`: a hash-routed fragment
 * (`#/login?token=…`) and nested URLs in values hold pairs of their own.
 */
function maskParams(text: string): MaskedPart {
  const parts = text
    .split(/([&?])/)
    .map((part, index) => (index % 2 === 1 ? { text: part, hidden: [] } : maskParam(part)));

  return {
    text: parts.map((part) => part.text).join(""),
    hidden: parts.flatMap((part) => part.hidden)
  };
}

function maskParam(pair: string): MaskedPart {
  const equals = pair.indexOf("=");
  const rawName = pair.slice(0, Math.max(0, equals));
  const name = decodeParamName(rawName);

  if (equals <= 0 || equals === pair.length - 1 || !SECRET_PARAM_PATTERN.test(name)) {
    return { text: pair, hidden: [] };
  }

  return { text: `${rawName}=${HIDDEN_VALUE}`, hidden: [name] };
}

/** A query name as `URLSearchParams` reads it: `+` is a space, then percent-decoded. */
function decodeParamName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
