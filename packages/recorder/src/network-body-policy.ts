import {
  redactBodyText,
  type CapturePolicy,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import { asRecord, asString } from "./normalizer-utils.js";

/** Upper bound of body text inspected by the masker, so huge frames stay cheap on the hot path. */
export const MAX_INLINE_BODY_SCAN_CHARS = 64 * 1024;
/** Max inline request body kept on `network.request` under the `body-allowlist` policy. */
export const MAX_INLINE_REQUEST_BODY_CHARS = 64 * 1024;
/** Max text kept from one WebSocket frame under the `body-allowlist` policy. */
export const MAX_WS_FRAME_PREVIEW_CHARS = 512;
/** Max text kept from one SSE message under the `body-allowlist` policy. */
export const MAX_SSE_DATA_CHARS = 800;

type InlineBodySlot = "request" | "ws-frame" | "sse";

/** Body text lifted off a network event before generic redaction. */
export type DetachedNetworkBody = {
  slot: InlineBodySlot;
  text: string;
};

export type DetachNetworkBodyResult = {
  payload: unknown;
  body: DetachedNetworkBody | null;
};

export type AttachNetworkBodyOptions = {
  capturePolicy: CapturePolicy | undefined;
  redactBodyPatterns: readonly string[];
  /** Extra gate on top of `body-allowlist` (e.g. site policies); called only when a body would be kept. */
  isBodyAllowed?: () => boolean;
};

/** What a host-side inline body gate (see `RecorderHooks.shouldKeepInlineNetworkBody`) gets to see. */
export type InlineNetworkBodyContext = {
  eventType: WebBlackboxEventType;
  /** Unsanitized request URL from the raw event, so site policy path rules match the real path. */
  url?: string;
  /** Request content type without parameters, lowercase. */
  mimeType?: string;
};

/**
 * Removes inline body text (request `postData`, WebSocket frame preview, SSE `data`) from a
 * normalized network payload, so generic key/value redaction never sees it and it can be re-attached
 * under the body policy by {@link attachInlineNetworkBody}.
 */
export function detachInlineNetworkBody(
  eventType: WebBlackboxEventType,
  payload: unknown
): DetachNetworkBodyResult {
  const row = asRecord(payload);

  if (!row) {
    return { payload, body: null };
  }

  switch (eventType) {
    case "network.request":
      return detachRequestBody(row);
    case "network.ws.frame":
      return detachWebSocketFrameBody(row);
    case "network.sse.message":
      return detachSseBody(row);
    default:
      return { payload, body: null };
  }
}

/**
 * Re-attaches detached body text only when the policy allows network bodies (`body-allowlist`),
 * value-masked with the shared body redactor and size-capped. Otherwise only sizes remain.
 */
export function attachInlineNetworkBody(
  payload: unknown,
  body: DetachedNetworkBody | null,
  options: AttachNetworkBodyOptions
): unknown {
  const row = asRecord(payload);

  if (!body || !row) {
    return payload;
  }

  if (
    options.capturePolicy?.categories.network !== "body-allowlist" ||
    options.isBodyAllowed?.() === false
  ) {
    return body.slot === "sse"
      ? { ...row, dataRedacted: true, dataSize: row.dataSize ?? body.text.length }
      : payload;
  }

  switch (body.slot) {
    case "request": {
      const masked = maskBodyText(body.text, MAX_INLINE_REQUEST_BODY_CHARS, options);
      return {
        ...row,
        request: {
          ...asRecord(row.request),
          postData: masked.value,
          ...(masked.truncated ? { postDataTruncated: true } : {})
        }
      };
    }
    case "ws-frame": {
      const masked = maskBodyText(body.text, MAX_WS_FRAME_PREVIEW_CHARS, options);
      return {
        ...row,
        frame: {
          ...asRecord(row.frame),
          payloadPreview: masked.value,
          ...(masked.truncated ? { payloadTruncated: true } : {})
        }
      };
    }
    case "sse": {
      const masked = maskBodyText(body.text, MAX_SSE_DATA_CHARS, options);
      return {
        ...row,
        data: masked.value,
        ...(masked.truncated ? { dataTruncated: true } : {})
      };
    }
  }
}

/** Builds the {@link InlineNetworkBodyContext} from the raw and the normalized payload. */
export function readInlineNetworkBodyContext(
  eventType: WebBlackboxEventType,
  rawPayload: unknown,
  payload: unknown
): InlineNetworkBodyContext {
  const raw = asRecord(rawPayload);
  const headers = asRecord(asRecord(asRecord(payload)?.request)?.headers);
  const contentType = asString(headers?.["content-type"]);

  return {
    eventType,
    url: asString(asRecord(raw?.request)?.url) ?? asString(raw?.url),
    mimeType: contentType?.split(";")[0]?.trim().toLowerCase() || undefined
  };
}

function detachRequestBody(row: Record<string, unknown>): DetachNetworkBodyResult {
  const request = asRecord(row.request);
  const text = readText(request?.postData) ?? readText(row.postData);
  const rest = omitKeys(row, ["postData", "postDataEntries"]);

  return {
    payload: request
      ? { ...rest, request: omitKeys(request, ["postData", "postDataEntries"]) }
      : rest,
    body: text === undefined ? null : { slot: "request", text }
  };
}

function detachWebSocketFrameBody(row: Record<string, unknown>): DetachNetworkBodyResult {
  const frame = asRecord(row.frame);
  const text = readText(frame?.payloadPreview);

  if (!frame || text === undefined) {
    return { payload: row, body: null };
  }

  return {
    payload: { ...row, frame: omitKeys(frame, ["payloadPreview"]) },
    body: { slot: "ws-frame", text }
  };
}

function detachSseBody(row: Record<string, unknown>): DetachNetworkBodyResult {
  if (row.data === undefined) {
    return { payload: row, body: null };
  }

  return {
    payload: omitKeys(row, ["data"]),
    body: { slot: "sse", text: readText(row.data) ?? stringifyBody(row.data) }
  };
}

function maskBodyText(
  text: string,
  maxChars: number,
  options: AttachNetworkBodyOptions
): { value: string; truncated: boolean } {
  const scanned = text.slice(0, MAX_INLINE_BODY_SCAN_CHARS);
  const masked = redactBodyText(scanned, options.redactBodyPatterns).value;

  return {
    value: masked.slice(0, maxChars),
    truncated: text.length > scanned.length || masked.length > maxChars
  };
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringifyBody(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function omitKeys(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}
