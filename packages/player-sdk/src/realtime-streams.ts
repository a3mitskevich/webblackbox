import type { RealtimeNetworkEntry } from "./index.js";
import {
  parseRealtimePayload,
  SIGNALR_RECORD_SEPARATOR,
  type RealtimePayloadFormat
} from "./realtime-messages.js";

/** What a stream's messages are: one payload format, or `mixed`. */
export type RealtimeStreamFormat = RealtimePayloadFormat | "mixed";

/** One WebSocket connection or SSE stream with its messages, in mono order. */
export type RealtimeStream = {
  /** The CDP request id (`requestId`) of the socket or of the SSE request. */
  streamId: string;
  protocol: "ws" | "sse";
  url?: string;
  /** `network.ws.open` time; absent when the recording started after the socket opened. */
  openMono?: number;
  openEventId?: string;
  /** `network.ws.close` time; absent while the socket was still open when recording stopped. */
  closeMono?: number;
  closeEventId?: string;
  /** First and last event of the stream (open, close or any message). */
  firstMono: number;
  lastMono: number;
  /** Frames (WebSocket) or messages (SSE), without the open and close events. */
  messages: RealtimeNetworkEntry[];
  sent: number;
  received: number;
  sentBytes: number;
  receivedBytes: number;
  /** Messages the archive keeps only a prefix of (`isRealtimePayloadCut`). */
  truncated: number;
  format: RealtimeStreamFormat;
};

/** Messages whose payload is read to tell the stream format (the first ones say enough). */
const FORMAT_SAMPLE = 24;

/** WebSocket opcode of a binary frame: CDP hands its payload over base64-encoded. */
const WS_BINARY_OPCODE = 2;

/**
 * Groups the realtime timeline (`getRealtimeNetworkTimeline`) by stream id. Entries without an id
 * (old page-hook archives) form one stream per protocol. Streams are ordered by their first event.
 */
export function buildRealtimeStreams(entries: readonly RealtimeNetworkEntry[]): RealtimeStream[] {
  const groups = new Map<string, RealtimeNetworkEntry[]>();

  for (const entry of entries) {
    const key = `${entry.protocol}:${entry.streamId ?? ""}`;
    const group = groups.get(key);

    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  return [...groups.values()]
    .map((group) => toStream([...group].sort((left, right) => left.mono - right.mono)))
    .sort((left, right) => left.firstMono - right.firstMono);
}

/**
 * Size of one message: the recorded payload length, else the kept text length. Both count text
 * frames in UTF-16 characters (what CDP reports), not wire bytes. A binary frame's length counts
 * base64 characters, so it is turned into the bytes they encode.
 */
export function realtimeMessageBytes(entry: RealtimeNetworkEntry): number {
  const length =
    typeof entry.payloadLength === "number" && Number.isFinite(entry.payloadLength)
      ? Math.max(0, entry.payloadLength)
      : (entry.payloadPreview?.length ?? 0);

  return entry.opcode === WS_BINARY_OPCODE
    ? base64Bytes(length, entry.payloadPreview ?? "")
    : length;
}

/**
 * The archive keeps only a prefix of this message: the recorder flagged it, or (older archives
 * that cut previews without a flag) the kept text is shorter than the recorded payload length and
 * no blob holds the rest. Binary frames and frames recorded without a preview (the recorder keeps
 * the length of every frame but a preview only of text ones) count as cut only when flagged.
 */
export function isRealtimePayloadCut(entry: RealtimeNetworkEntry): boolean {
  if (entry.payloadTruncated === true) {
    return true;
  }

  if (
    entry.payloadHash ||
    entry.opcode === WS_BINARY_OPCODE ||
    entry.payloadPreview === undefined ||
    typeof entry.payloadLength !== "number"
  ) {
    return false;
  }

  // Both lengths are UTF-16 character counts.
  return entry.payloadPreview.length < entry.payloadLength;
}

/** Bytes encoded by `length` base64 characters; the kept text, when whole, tells the padding. */
function base64Bytes(length: number, text: string): number {
  const padding = text.length === length ? (/=*$/.exec(text)?.[0].length ?? 0) : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - Math.min(2, padding));
}

function toStream(group: RealtimeNetworkEntry[]): RealtimeStream {
  const first = group[0] as RealtimeNetworkEntry;
  const open = group.find((entry) => entry.eventType === "network.ws.open");
  const close = group.find((entry) => entry.eventType === "network.ws.close");
  const messages = group.filter(
    (entry) => entry.eventType !== "network.ws.open" && entry.eventType !== "network.ws.close"
  );
  let sent = 0;
  let received = 0;
  let sentBytes = 0;
  let receivedBytes = 0;
  let truncated = 0;

  for (const message of messages) {
    const bytes = realtimeMessageBytes(message);

    if (message.direction === "sent") {
      sent += 1;
      sentBytes += bytes;
    } else if (isReceived(message)) {
      received += 1;
      receivedBytes += bytes;
    }

    if (isRealtimePayloadCut(message)) {
      truncated += 1;
    }
  }

  return {
    streamId: first.streamId ?? "",
    protocol: first.protocol,
    ...readUrl(group),
    ...(open ? { openMono: open.mono, openEventId: open.eventId } : {}),
    ...(close ? { closeMono: close.mono, closeEventId: close.eventId } : {}),
    firstMono: first.mono,
    lastMono: group[group.length - 1]?.mono ?? first.mono,
    messages,
    sent,
    received,
    sentBytes,
    receivedBytes,
    truncated,
    format: readStreamFormat(messages)
  };
}

/** SSE only flows from the server; a WebSocket frame needs its recorded direction. */
function isReceived(message: RealtimeNetworkEntry): boolean {
  return message.direction === "received" || message.protocol === "sse";
}

function readUrl(group: RealtimeNetworkEntry[]): { url?: string } {
  const url = group.find((entry) => typeof entry.url === "string" && entry.url.length > 0)?.url;
  return url ? { url } : {};
}

function readStreamFormat(messages: RealtimeNetworkEntry[]): RealtimeStreamFormat {
  // One separator anywhere makes it a hub connection: cut frames lose theirs.
  if (messages.some((entry) => entry.payloadPreview?.includes(SIGNALR_RECORD_SEPARATOR))) {
    return "signalr";
  }

  const sample = messages.slice(0, FORMAT_SAMPLE);

  const formats = new Set(
    sample
      .map(
        (entry) =>
          parseRealtimePayload(entry.payloadPreview, {
            truncated: entry.payloadTruncated,
            opcode: entry.opcode
          }).format
      )
      .filter((format) => format !== "empty")
  );

  if (formats.size === 0) {
    return "empty";
  }

  return formats.size === 1 ? ([...formats][0] as RealtimePayloadFormat) : "mixed";
}
