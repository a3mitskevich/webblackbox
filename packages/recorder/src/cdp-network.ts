import { isTextualMimeType } from "@webblackbox/protocol";

import {
  asArray,
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  normalizeHeaderRecord,
  sanitizeOptionalUrl,
  stripUndefined
} from "./normalizer-utils.js";

const WS_TEXT_OPCODE = 1;
const MAX_TIMING_FIELDS = 32;
/** Max `requestServedFromCache` marks waiting for their response/finish; the oldest go first. */
export const MAX_TRACKED_CACHED_REQUESTS = 2048;

type RequestBody = {
  size?: number;
  text?: string;
};

/**
 * Projects a raw CDP `Network.*` event onto an explicit field allowlist. Everything not listed
 * (raw header text, security details, initiator stacks, base64 `postDataEntries`, WebSocket
 * `payloadData`, ...) is dropped.
 *
 * Body text is never base64 and only ever lands in `request.postData` (textual request bodies) or
 * `frame.payloadPreview` (text WebSocket frames). These are raw here: the recorder gates them on
 * the capture policy and masks/caps them before the event is stored.
 */
export function normalizeCdpNetworkPayload(
  rawType: string,
  payload: unknown
): Record<string, unknown> {
  const row = asRecord(payload) ?? {};

  switch (rawType) {
    case "Network.requestWillBeSent":
      return normalizeRequestWillBeSent(row);
    case "Network.responseReceived":
      return stripUndefined({
        ...readEventIds(row),
        type: asString(row.type),
        hasExtraInfo: asBoolean(row.hasExtraInfo),
        response: normalizeResponse(asRecord(row.response) ?? row)
      });
    case "Network.loadingFinished":
      return stripUndefined({
        ...readEventIds(row),
        encodedDataLength: readByteLength(row.encodedDataLength)
      });
    case "Network.loadingFailed":
      return stripUndefined({
        ...readEventIds(row),
        type: asString(row.type),
        errorText: asString(row.errorText),
        canceled: asBoolean(row.canceled),
        blockedReason: asString(row.blockedReason),
        corsErrorStatus: normalizeCorsErrorStatus(row.corsErrorStatus)
      });
    case "Network.webSocketCreated":
      return stripUndefined({
        ...readEventIds(row),
        url: sanitizeOptionalUrl(asString(row.url)),
        initiator: normalizeInitiator(row.initiator)
      });
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived":
      return stripUndefined({
        ...readEventIds(row),
        direction: rawType === "Network.webSocketFrameSent" ? "sent" : "received",
        frame: normalizeWebSocketFrame(asRecord(row.response))
      });
    default:
      return stripUndefined(readEventIds(row));
  }
}

/**
 * Remembers `Network.requestServedFromCache` (which has no event of its own) and marks the request's
 * `network.response` (`response.fromMemoryCache`) and `network.finished` (`fromMemoryCache`), so a
 * memory-cache hit — including one that never gets `responseReceived` — closes as "from cache".
 * Chrome sends it for memory-cache and data: URL hits; disk-cache hits carry `fromDiskCache` instead.
 */
export class CdpCacheTracker {
  private readonly servedFromCache = new Set<string>();

  /** Records a `requestServedFromCache` event. */
  public remember(cdpSessionId: string | undefined, payload: unknown): void {
    const requestId = asString(asRecord(payload)?.requestId);

    if (!requestId) {
      return;
    }

    const key = buildCacheKey(cdpSessionId, requestId);
    this.servedFromCache.delete(key);
    this.servedFromCache.add(key);

    if (this.servedFromCache.size > MAX_TRACKED_CACHED_REQUESTS) {
      const oldest = this.servedFromCache.values().next().value;

      if (oldest !== undefined) {
        this.servedFromCache.delete(oldest);
      }
    }
  }

  /** Adds the cache mark to a normalized response/finish payload; a finish or failure ends tracking. */
  public annotate(
    rawType: string,
    cdpSessionId: string | undefined,
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const requestId = asString(payload.requestId);

    if (!requestId) {
      return payload;
    }

    const key = buildCacheKey(cdpSessionId, requestId);

    if (!this.servedFromCache.has(key)) {
      return payload;
    }

    if (rawType === "Network.responseReceived") {
      const response = asRecord(payload.response);
      return response && response.fromDiskCache !== true
        ? { ...payload, response: { ...response, fromMemoryCache: true } }
        : payload;
    }

    if (rawType === "Network.loadingFinished" || rawType === "Network.loadingFailed") {
      this.servedFromCache.delete(key);
      return rawType === "Network.loadingFinished"
        ? { ...payload, fromMemoryCache: true }
        : payload;
    }

    return payload;
  }
}

function buildCacheKey(cdpSessionId: string | undefined, requestId: string): string {
  return `${cdpSessionId ?? ""}\u0000${requestId}`;
}

/** CDP uses -1 for "unknown" (e.g. blob: URLs); only real byte counts are kept. */
function readByteLength(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : undefined;
}

function readEventIds(row: Record<string, unknown>): Record<string, unknown> {
  return {
    reqId: asString(row.reqId),
    requestId: asString(row.requestId),
    loaderId: asString(row.loaderId),
    frameId: asString(row.frameId),
    timestamp: asFiniteNumber(row.timestamp) ?? undefined
  };
}

function normalizeRequestWillBeSent(row: Record<string, unknown>): Record<string, unknown> {
  const request = asRecord(row.request) ?? row;
  const headers = normalizeHeaderRecord(request.headers);
  const body = readRequestBody(request, headers?.["content-type"]);
  const hasPostData =
    asBoolean(request.hasPostData) ?? (body.size !== undefined ? body.size > 0 : undefined);

  return stripUndefined({
    ...readEventIds(row),
    wallTime: asFiniteNumber(row.wallTime) ?? undefined,
    type: asString(row.type),
    documentURL: sanitizeOptionalUrl(asString(row.documentURL)),
    hasUserGesture: asBoolean(row.hasUserGesture),
    initiator: normalizeInitiator(row.initiator),
    redirectResponse: normalizeResponse(asRecord(row.redirectResponse)),
    postDataSize: body.size,
    request: emptyToUndefined(
      stripUndefined({
        url: sanitizeOptionalUrl(asString(request.url)),
        method: asString(request.method)?.toUpperCase(),
        headers,
        hasPostData,
        postData: body.text,
        initialPriority: asString(request.initialPriority),
        referrerPolicy: asString(request.referrerPolicy)
      })
    )
  });
}

function normalizeResponse(
  response: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  if (!response) {
    return undefined;
  }

  return emptyToUndefined(
    stripUndefined({
      url: sanitizeOptionalUrl(asString(response.url)),
      status: asFiniteNumber(response.status) ?? undefined,
      statusText: asString(response.statusText),
      headers: normalizeHeaderRecord(response.headers),
      mimeType: asString(response.mimeType),
      charset: asString(response.charset),
      protocol: asString(response.protocol),
      securityState: asString(response.securityState),
      connectionReused: asBoolean(response.connectionReused),
      fromDiskCache: asBoolean(response.fromDiskCache),
      fromServiceWorker: asBoolean(response.fromServiceWorker),
      fromPrefetchCache: asBoolean(response.fromPrefetchCache),
      encodedDataLength: readByteLength(response.encodedDataLength),
      responseTime: asFiniteNumber(response.responseTime) ?? undefined,
      timing: normalizeTiming(response.timing)
    })
  );
}

function normalizeTiming(value: unknown): Record<string, number> | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const output: Record<string, number> = {};

  for (const [key, entry] of Object.entries(row).slice(0, MAX_TIMING_FIELDS)) {
    const numeric = asFiniteNumber(entry);

    if (numeric !== null) {
      output[key] = numeric;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeInitiator(value: unknown): Record<string, unknown> | undefined {
  const type = asString(asRecord(value)?.type);
  return type ? { type } : undefined;
}

function normalizeCorsErrorStatus(value: unknown): Record<string, unknown> | undefined {
  const corsError = asString(asRecord(value)?.corsError);
  return corsError ? { corsError } : undefined;
}

function normalizeWebSocketFrame(
  response: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  if (!response) {
    return undefined;
  }

  const opcode = asFiniteNumber(response.opcode) ?? undefined;
  const payloadData = asString(response.payloadData);

  return stripUndefined({
    opcode,
    masked: asBoolean(response.mask),
    payloadLength: payloadData?.length,
    // Binary frames arrive base64-encoded; only text frames may carry a (policy-gated) preview.
    payloadPreview: opcode === WS_TEXT_OPCODE && payloadData ? payloadData : undefined
  });
}

function readRequestBody(
  request: Record<string, unknown>,
  contentType: string | undefined
): RequestBody {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() || undefined;
  const entryBytes = decodePostDataEntries(request.postDataEntries);

  if (entryBytes) {
    return {
      size: entryBytes.byteLength,
      text: decodeTextualBody(entryBytes, mimeType)
    };
  }

  const postData = asString(request.postData);

  if (postData === undefined) {
    return {};
  }

  return {
    size: new TextEncoder().encode(postData).byteLength,
    text: !mimeType || isTextualMimeType(mimeType) ? postData : undefined
  };
}

function decodePostDataEntries(value: unknown): Uint8Array | null {
  const chunks: Uint8Array[] = [];

  for (const entry of asArray(value)) {
    const bytes = asString(asRecord(entry)?.bytes);

    if (bytes === undefined) {
      continue;
    }

    const decoded = decodeBase64(bytes);

    if (!decoded) {
      return null;
    }

    chunks.push(decoded);
  }

  if (chunks.length === 0) {
    return null;
  }

  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

function decodeTextualBody(bytes: Uint8Array, mimeType: string | undefined): string | undefined {
  if (mimeType) {
    return isTextualMimeType(mimeType) ? new TextDecoder().decode(bytes) : undefined;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function emptyToUndefined(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}
