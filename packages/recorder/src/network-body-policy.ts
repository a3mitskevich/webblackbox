import {
  normalizeMimeType,
  redactBodyText,
  type BodySkipReason,
  type CapturePolicy,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import { asRecord, asString, omitKeys } from "./normalizer-utils.js";

/** Upper bound of body text inspected by the masker, so huge frames stay cheap on the hot path. */
export const MAX_INLINE_BODY_SCAN_CHARS = 64 * 1024;
/**
 * Inline request body kept on `network.request` under `body-allowlist` when the profile sets no
 * body size (`sampling.bodyCaptureMaxBytes` = 0); otherwise bodies are kept up to that many bytes.
 */
export const MAX_INLINE_REQUEST_BODY_CHARS = 64 * 1024;
/**
 * Text kept from one WebSocket frame under `body-allowlist` when the profile sets no body size
 * (`sampling.bodyCaptureMaxBytes` = 0); otherwise frames are kept up to that many UTF-8 bytes.
 */
export const MAX_WS_FRAME_PREVIEW_CHARS = 512;
/** Same as {@link MAX_WS_FRAME_PREVIEW_CHARS}, for one SSE message. */
export const MAX_SSE_DATA_CHARS = 800;

/** Where a kept body is cut: a char count (legacy previews) or the profile's UTF-8 byte budget. */
type BodyCap = { unit: "chars" | "bytes"; limit: number };

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
  /** Profile body size (`sampling.bodyCaptureMaxBytes`); caps WebSocket frames and SSE messages. */
  maxBodyBytes?: number;
  /**
   * Extra gate on top of `body-allowlist` (e.g. site policies); called only when a body would be
   * kept. `true` keeps it; `false` or a reason drops it, and a dropped request body is recorded
   * as `request.postDataSkipped` (`false` means `filtered`).
   */
  isBodyAllowed?: () => boolean | BodySkipReason;
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

  if (options.capturePolicy?.categories.network !== "body-allowlist") {
    return dropInlineBody(row, body);
  }

  const verdict = options.isBodyAllowed?.() ?? true;

  if (verdict !== true) {
    // The policy asked for bodies and a host rule left this one out: say so, never drop silently.
    return body.slot === "request"
      ? {
          ...row,
          request: {
            ...asRecord(row.request),
            postDataSkipped: verdict === false ? "filtered" : verdict
          }
        }
      : dropInlineBody(row, body);
  }

  switch (body.slot) {
    case "request": {
      const masked = maskBodyText(
        body.text,
        resolveStreamCap(options.maxBodyBytes, MAX_INLINE_REQUEST_BODY_CHARS),
        options
      );
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
      const masked = maskBodyText(
        body.text,
        resolveStreamCap(options.maxBodyBytes, MAX_WS_FRAME_PREVIEW_CHARS),
        options
      );
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
      const masked = maskBodyText(
        body.text,
        resolveStreamCap(options.maxBodyBytes, MAX_SSE_DATA_CHARS),
        options
      );
      return {
        ...row,
        data: masked.value,
        ...(masked.truncated ? { dataTruncated: true } : {})
      };
    }
  }
}

function dropInlineBody(row: Record<string, unknown>, body: DetachedNetworkBody): unknown {
  return body.slot === "sse"
    ? { ...row, dataRedacted: true, dataSize: row.dataSize ?? body.text.length }
    : row;
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
    mimeType: normalizeMimeType(contentType)
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

function resolveStreamCap(maxBodyBytes: number | undefined, legacyChars: number): BodyCap {
  return maxBodyBytes !== undefined && Number.isFinite(maxBodyBytes) && maxBodyBytes > 0
    ? { unit: "bytes", limit: Math.floor(maxBodyBytes) }
    : { unit: "chars", limit: legacyChars };
}

function maskBodyText(
  text: string,
  cap: BodyCap,
  options: AttachNetworkBodyOptions
): { value: string; truncated: boolean } {
  // A byte budget never keeps more chars than bytes, so scanning `limit` chars covers it.
  const scanned = text.slice(0, Math.max(MAX_INLINE_BODY_SCAN_CHARS, cap.limit));
  const masked = redactBodyText(scanned, options.redactBodyPatterns).value;
  const value = cap.unit === "bytes" ? truncateUtf8(masked, cap.limit) : masked.slice(0, cap.limit);

  return {
    value,
    truncated: text.length > scanned.length || value.length < masked.length
  };
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  // UTF-8 needs at most 3 bytes per UTF-16 code unit, so short text fits without encoding.
  if (text.length * 3 <= maxBytes) {
    return text;
  }

  const bytes = new TextEncoder().encode(text);

  if (bytes.byteLength <= maxBytes) {
    return text;
  }

  let end = maxBytes;

  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return new TextDecoder().decode(bytes.subarray(0, end));
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
