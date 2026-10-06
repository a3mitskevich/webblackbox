import {
  type BodySkipReason,
  extractRequestId,
  isBodySkipReason,
  type WebBlackboxEvent,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import type { WebBlackboxPlayer } from "./index.js";
import type {
  NetworkBodySkip,
  NetworkCacheSource,
  NetworkWaterfallEntry,
  RealtimeNetworkEntry,
  RequestResponseDiff
} from "./types.js";
import { asBoolean, asNumber, asRecord, asString, byteLengthUtf8 } from "./value-readers.js";

const NETWORK_EVENT_TYPES = new Set<WebBlackboxEventType>([
  "network.request",
  "network.response",
  "network.finished",
  "network.failed",
  "network.redirect",
  "network.body",
  "network.body.skipped"
]);

export function buildNetworkWaterfall(events: WebBlackboxEvent[]): NetworkWaterfallEntry[] {
  const scoped = events.filter((event) => NETWORK_EVENT_TYPES.has(event.type));
  const buckets = collectNetworkBuckets(scoped);

  return buckets
    .map((bucket) => toNetworkEntry(bucket))
    .sort(
      (left, right) => left.startMono - right.startMono || left.reqId.localeCompare(right.reqId)
    );
}

export async function buildRequestResponseDiff(
  player: Pick<WebBlackboxPlayer, "getNetworkWaterfall" | "getBlob">,
  reqId: string
): Promise<RequestResponseDiff | null> {
  const entry = player.getNetworkWaterfall().find((item) => item.reqId === reqId);

  if (!entry) {
    return null;
  }

  const responseBody = entry.responseBodyHash ? await player.getBlob(entry.responseBodyHash) : null;
  const requestBodyBytes = byteLengthUtf8(entry.requestBodyText ?? "");
  const responseBodyBytes = responseBody?.bytes.byteLength ?? 0;
  const missingReplayInputs = [];

  if (!entry.requestBodyText && !["GET", "HEAD"].includes(entry.method.toUpperCase())) {
    missingReplayInputs.push("request-body");
  }

  if (!entry.responseBodyHash) {
    missingReplayInputs.push("response-body");
  }

  return {
    reqId: entry.reqId,
    method: entry.method,
    url: entry.url,
    status: entry.status ?? null,
    requestBodyBytes,
    responseBodyBytes,
    bodySizeDeltaBytes: responseBodyBytes - requestBodyBytes,
    requestHeaderNames: Object.keys(entry.requestHeaders).sort(),
    responseHeaderNames: Object.keys(entry.responseHeaders).sort(),
    missingReplayInputs
  };
}

export async function readRealtimePayloadText(
  player: Pick<WebBlackboxPlayer, "getRealtimeNetworkTimeline" | "getBlob">,
  eventId: string
): Promise<string | null> {
  const entry = player.getRealtimeNetworkTimeline().find((item) => item.eventId === eventId);

  if (!entry) {
    return null;
  }

  if (!entry.payloadHash) {
    return entry.payloadPreview ?? null;
  }

  const blob = await player.getBlob(entry.payloadHash);

  if (!blob) {
    throw new Error(`Realtime payload blob ${entry.payloadHash} is missing from the archive.`);
  }

  return new TextDecoder().decode(blob.bytes);
}

export function buildRealtimeNetworkTimeline(events: WebBlackboxEvent[]): RealtimeNetworkEntry[] {
  return events
    .filter((event) => event.type.startsWith("network.ws.") || event.type === "network.sse.message")
    .map((event) => {
      const payload = asRecord(event.data);
      const frame = asRecord(payload?.frame);
      const protocol: RealtimeNetworkEntry["protocol"] = event.type.startsWith("network.ws.")
        ? "ws"
        : "sse";

      return {
        eventId: event.id,
        eventType: event.type,
        protocol,
        mono: event.mono,
        t: event.t,
        streamId:
          asString(payload?.requestId) ?? asString(payload?.reqId) ?? asString(payload?.streamId),
        direction: readRealtimeDirection(payload),
        phase: asString(payload?.phase),
        url: asString(payload?.url),
        opcode: asNumber(frame?.opcode) ?? asNumber(asRecord(payload?.response)?.opcode),
        payloadLength: asNumber(frame?.payloadLength),
        payloadPreview:
          asString(frame?.payloadPreview) ??
          asString(payload?.data) ??
          asString(asRecord(payload?.response)?.payloadData),
        payloadHash: asString(frame?.payloadHash) ?? asString(payload?.dataHash),
        payloadTruncated: asBoolean(frame?.payloadTruncated) ?? asBoolean(payload?.dataTruncated),
        snapshot: payload
      };
    })
    .sort((left, right) => left.mono - right.mono);
}

type MutableNetworkBucket = {
  reqId: string;
  events: WebBlackboxEvent[];
  request?: WebBlackboxEvent;
  response?: WebBlackboxEvent;
  finished?: WebBlackboxEvent;
  failed?: WebBlackboxEvent;
  body?: WebBlackboxEvent;
  bodySkipped?: WebBlackboxEvent;
  startMono: number;
  endMono: number;
  startWallTime: number;
  endWallTime: number;
  actionId?: string;
};

function collectNetworkBuckets(events: WebBlackboxEvent[]): MutableNetworkBucket[] {
  const buckets = new Map<string, MutableNetworkBucket>();

  for (const event of events) {
    const reqId = extractRequestId(event);

    if (!reqId) {
      continue;
    }

    const bucket = buckets.get(reqId) ?? {
      reqId,
      events: [],
      startMono: event.mono,
      endMono: event.mono,
      startWallTime: event.t,
      endWallTime: event.t
    };

    bucket.events.push(event);
    bucket.startMono = Math.min(bucket.startMono, event.mono);
    bucket.endMono = Math.max(bucket.endMono, event.mono);
    bucket.startWallTime = Math.min(bucket.startWallTime, event.t);
    bucket.endWallTime = Math.max(bucket.endWallTime, event.t);

    if (!bucket.actionId && event.ref?.act) {
      bucket.actionId = event.ref.act;
    }

    if (event.type === "network.request" && !bucket.request) {
      bucket.request = event;
    }

    if (event.type === "network.response") {
      bucket.response = event;
    }

    if (event.type === "network.finished") {
      bucket.finished = event;
    }

    if (event.type === "network.failed") {
      bucket.failed = event;
    }

    if (event.type === "network.body") {
      bucket.body = event;
    }

    if (event.type === "network.body.skipped" && asRecord(event.data)?.side !== "request") {
      bucket.bodySkipped = event;
    }

    buckets.set(reqId, bucket);
  }

  return [...buckets.values()];
}

function toNetworkEntry(bucket: MutableNetworkBucket): NetworkWaterfallEntry {
  const requestPayload = asRecord(bucket.request?.data);
  const responsePayload = asRecord(bucket.response?.data);
  const finishedPayload = asRecord(bucket.finished?.data);
  const failedPayload = asRecord(bucket.failed?.data);
  const bodyPayload = asRecord(bucket.body?.data);

  const requestObject = asRecord(requestPayload?.request);
  const responseObject = asRecord(responsePayload?.response);

  const method =
    asString(requestObject?.method) ??
    asString(requestPayload?.method) ??
    asString(responsePayload?.method) ??
    "GET";
  const url =
    asString(requestObject?.url) ??
    asString(requestPayload?.url) ??
    asString(responseObject?.url) ??
    asString(responsePayload?.url) ??
    "unknown://request";

  const status = asNumber(responseObject?.status) ?? asNumber(responsePayload?.status);
  const statusText = asString(responseObject?.statusText) ?? asString(responsePayload?.statusText);
  const mimeType = asString(responseObject?.mimeType) ?? asString(responsePayload?.mimeType);
  const encodedDataLength =
    asNumber(responseObject?.encodedDataLength) ??
    asNumber(responsePayload?.encodedDataLength) ??
    asNumber(finishedPayload?.encodedDataLength);

  const requestHeaders = normalizeHeaders(requestObject?.headers ?? requestPayload?.headers);
  const responseHeaders = normalizeHeaders(responseObject?.headers ?? responsePayload?.headers);

  const requestBodyText =
    asString(requestObject?.postData) ??
    asString(requestPayload?.postData) ??
    asString(requestPayload?.body) ??
    undefined;

  const durationFromPayload =
    asNumber(responsePayload?.duration) ??
    asNumber(finishedPayload?.duration) ??
    asNumber(failedPayload?.duration);

  const durationMs = Math.max(0, durationFromPayload ?? bucket.endMono - bucket.startMono);

  return {
    reqId: bucket.reqId,
    url,
    method,
    status,
    statusText,
    mimeType,
    startMono: bucket.startMono,
    endMono: bucket.endMono,
    durationMs,
    startWallTime: bucket.startWallTime,
    endWallTime: bucket.endWallTime,
    failed: Boolean(bucket.failed),
    errorText: asString(failedPayload?.errorText) ?? asString(failedPayload?.message),
    actionId: bucket.actionId,
    encodedDataLength,
    requestHeaders,
    responseHeaders,
    requestBodyText,
    requestHasBody:
      requestObject?.hasPostData === true || (asNumber(requestPayload?.postDataSize) ?? 0) > 0
        ? true
        : undefined,
    requestBodyTruncated:
      requestObject?.postDataTruncated === true || requestPayload?.postDataTruncated === true
        ? true
        : undefined,
    requestBodySkipReason: requestBodyText
      ? undefined
      : readBodySkipReason(requestObject?.postDataSkipped ?? requestPayload?.postDataSkipped),
    responseBodyHash: asString(bodyPayload?.contentHash),
    responseBodySize: asNumber(bodyPayload?.size) ?? asNumber(bodyPayload?.sampledSize),
    responseBodyTruncated: bodyPayload?.truncated === true ? true : undefined,
    responseBodySkip: bodyPayload?.contentHash
      ? undefined
      : readNetworkBodySkip(asRecord(bucket.bodySkipped?.data)),
    fromCache: readNetworkCacheSource(responseObject ?? responsePayload, finishedPayload),
    pending: bucket.response || bucket.finished || bucket.failed ? undefined : true,
    eventIds: bucket.events.map((event) => event.id)
  };
}

function readBodySkipReason(value: unknown): BodySkipReason | undefined {
  return isBodySkipReason(value) ? value : undefined;
}

function readNetworkBodySkip(payload: Record<string, unknown> | null): NetworkBodySkip | undefined {
  const reason = readBodySkipReason(payload?.reason);

  if (!reason) {
    return undefined;
  }

  return {
    reason,
    size: asNumber(payload?.size),
    limit: asNumber(payload?.limit),
    detail: asString(payload?.detail)
  };
}

function readNetworkCacheSource(
  response: Record<string, unknown> | null,
  finished: Record<string, unknown> | null
): NetworkCacheSource | undefined {
  if (response?.fromDiskCache === true) {
    return "disk";
  }

  if (response?.fromMemoryCache === true || finished?.fromMemoryCache === true) {
    return "memory";
  }

  if (response?.fromPrefetchCache === true) {
    return "prefetch";
  }

  return response?.fromServiceWorker === true ? "service-worker" : undefined;
}

function readRealtimeDirection(
  payload: Record<string, unknown> | null
): RealtimeNetworkEntry["direction"] {
  const explicitDirection = asString(payload?.direction);

  if (explicitDirection === "sent" || explicitDirection === "received") {
    return explicitDirection;
  }

  return explicitDirection ? "unknown" : undefined;
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const entries: Array<[string, string]> = [];

    for (const item of raw) {
      const row = asRecord(item);
      const name = asString(row?.name);
      const value = asString(row?.value);

      if (!name || value === undefined) {
        continue;
      }

      entries.push([name.toLowerCase(), value]);
    }

    return Object.fromEntries(entries);
  }

  const record = asRecord(raw);

  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .map(([name, value]) => [name.toLowerCase(), asString(value)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
