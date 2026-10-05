import type { WebBlackboxEvent } from "@webblackbox/protocol";

/** WebSocket frames and SSE messages up to this many chars stay inline in the event chunk. */
export const MAX_INLINE_STREAM_PAYLOAD_CHARS = 16 * 1024;
/** Head kept inline next to the blob hash, for lists and full-text search. */
export const STREAM_PAYLOAD_PREVIEW_CHARS = 512;

const STREAM_PAYLOAD_MIME = "text/plain";

export type PutBlob = (mime: string, bytes: Uint8Array) => Promise<string>;

/**
 * Moves the text of a large WebSocket frame (`frame.payloadPreview`) or SSE message (`data`) into a
 * content-addressed blob, like response bodies: the event keeps a short head plus `payloadHash` /
 * `dataHash`. Keeps event chunks small when a profile records full socket traffic. Other events,
 * and payloads that already reference a blob, are returned unchanged.
 */
export async function externalizeStreamPayload(
  event: WebBlackboxEvent,
  putBlob: PutBlob
): Promise<WebBlackboxEvent> {
  const data = asRecord(event.data);

  if (!data) {
    return event;
  }

  if (event.type === "network.ws.frame") {
    const frame = asRecord(data.frame);
    const text = readOversizedText(frame?.payloadPreview, frame?.payloadHash);

    if (!frame || text === null) {
      return event;
    }

    const hash = await putBlob(STREAM_PAYLOAD_MIME, new TextEncoder().encode(text));
    return {
      ...event,
      data: { ...data, frame: { ...frame, payloadPreview: readHead(text), payloadHash: hash } }
    };
  }

  if (event.type === "network.sse.message") {
    const text = readOversizedText(data.data, data.dataHash);

    if (text === null) {
      return event;
    }

    const hash = await putBlob(STREAM_PAYLOAD_MIME, new TextEncoder().encode(text));
    return { ...event, data: { ...data, data: readHead(text), dataHash: hash } };
  }

  return event;
}

function readOversizedText(value: unknown, existingHash: unknown): string | null {
  return typeof value === "string" &&
    value.length > MAX_INLINE_STREAM_PAYLOAD_CHARS &&
    existingHash === undefined
    ? value
    : null;
}

/** First {@link STREAM_PAYLOAD_PREVIEW_CHARS} chars, without a dangling high surrogate. */
function readHead(text: string): string {
  const head = text.slice(0, STREAM_PAYLOAD_PREVIEW_CHARS);
  const lastCode = head.charCodeAt(head.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? head.slice(0, -1) : head;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
