import type { WebBlackboxEvent } from "@webblackbox/protocol";

/**
 * Details of one request for an inspector: the timing phases (from Chrome's ResourceTiming when
 * the archive has it), the initiator and connection facts, and a URL fit for display with secret
 * query values hidden. Archive data is untrusted: every field is read defensively.
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
  /** Query parameters whose values were hidden (`access_token`, `signature`, …). */
  hiddenParams: string[];
};

const MAX_INITIATOR_FRAMES = 40;
const SECRET_PARAM_PATTERN =
  /token|secret|password|passwd|signature|credential|api[-_]?key|jwt|session|^auth$|^key$|^sig$|^code$|^pwd$|^sid$/i;
const HIDDEN_VALUE = "…";

/**
 * Timing of one request from its events (`getRequestEvents`): Chrome ResourceTiming phases when the
 * response carries `timing`, otherwise waiting (request → response) and download (response → end).
 */
export function readRequestTiming(events: readonly WebBlackboxEvent[]): RequestTiming {
  const request = events.find((event) => event.type === "network.request");
  const response = events.find((event) => event.type === "network.response");
  const end = events.find(
    (event) => event.type === "network.finished" || event.type === "network.failed"
  );
  const fromResourceTiming = readResourceTiming(request, response, end);

  if (fromResourceTiming) {
    return fromResourceTiming;
  }

  const phases: RequestTimingPhase[] = [];
  const startMono = request?.mono ?? events[0]?.mono;

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
  const base =
    requestSeconds !== undefined ? Math.max(0, (requestTime - requestSeconds) * 1_000) : 0;
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
 * The URL with the values of secret-looking query parameters replaced by `…` (tokens in WebSocket
 * URLs, signed links). Unparseable input comes back unchanged.
 */
export function maskSensitiveUrl(url: string): MaskedUrl {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return { url, hiddenParams: [] };
  }

  const hiddenParams: string[] = [];

  for (const [name, value] of parsed.searchParams) {
    if (value.length > 0 && SECRET_PARAM_PATTERN.test(name) && !hiddenParams.includes(name)) {
      hiddenParams.push(name);
    }
  }

  if (hiddenParams.length === 0) {
    return { url, hiddenParams };
  }

  for (const name of hiddenParams) {
    parsed.searchParams.set(name, HIDDEN_VALUE);
  }

  return { url: decodeUriSafe(parsed.toString()), hiddenParams };
}

function decodeUriSafe(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
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
