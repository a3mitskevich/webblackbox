import {
  readRequestConnection,
  readRequestTiming,
  type ActionSpan,
  type NetworkWaterfallEntry,
  type RealtimeNetworkEntry,
  type WebBlackboxPlayer
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import * as z from "zod";

import { findActionByTime, findActionSpan } from "./archive-lookup.js";
import { missingBody, viewBodyBytes, viewBodyText, type BodyView } from "./body-view.js";
import { capList, cutText, decodeCursor, encodeCursor, fitRows } from "./budget.js";
import { defineArchiveTool, type ArchiveToolOutput } from "./registry.js";
import { asNumber, asRecord, asString, round2 } from "./values.js";

const DEFAULT_MAX_BODY_BYTES = 16_384;
const MIN_MAX_BODY_BYTES = 256;
const MAX_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_FRAME_LIMIT = 20;
const MAX_FRAME_LIMIT = 200;
const DEFAULT_MAX_FRAME_BYTES = 1_000;
const MAX_MAX_FRAME_BYTES = 65_536;
const FRAMES_PAGE_MAX_BYTES = 256_000;
const HEADER_VALUE_MAX_BYTES = 2_048;
/** A `data:` URL can carry a whole file; the request is still identified by its first bytes. */
const URL_MAX_BYTES = 4_096;
const INITIATOR_FRAME_LIMIT = 10;
const EVENT_LIMIT = 20;
const REALTIME_MESSAGE_TYPES = new Set(["network.ws.frame", "network.sse.message"]);

export const requestDetailInput = {
  requestId: z
    .string()
    .min(1)
    .max(512)
    .describe("Request id (`requestId` in timeline rows, `reqId` in network tools)."),
  bodies: z
    .enum(["both", "request", "response", "none"])
    .optional()
    .describe("Which bodies to return (default both)."),
  maxBodyBytes: z
    .number()
    .int()
    .min(MIN_MAX_BODY_BYTES)
    .max(MAX_MAX_BODY_BYTES)
    .optional()
    .describe(
      `Bytes of each body to return (default ${DEFAULT_MAX_BODY_BYTES}); a cut says "N of M bytes".`
    ),
  frameLimit: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRAME_LIMIT)
    .optional()
    .describe(`WebSocket/SSE messages per page (default ${DEFAULT_FRAME_LIMIT}).`),
  frameCursor: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("`frames.nextCursor` of a previous call, to page through socket messages."),
  maxFrameBytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_MAX_FRAME_BYTES)
    .optional()
    .describe(
      `Bytes of each socket message payload to return (default ${DEFAULT_MAX_FRAME_BYTES}).`
    )
};

export type RequestDetailArgs = {
  requestId: string;
  bodies?: "both" | "request" | "response" | "none";
  maxBodyBytes?: number;
  frameLimit?: number;
  frameCursor?: string;
  maxFrameBytes?: number;
};

export const requestDetailTool = defineArchiveTool({
  name: "request_detail",
  description:
    "One network request in full: method, URL, status, timing phases, request/response headers, " +
    "decoded request and response bodies (JSON pretty-printed, cut with 'N of M bytes'), " +
    "initiator, redirects, the action that caused it, and WebSocket/SSE messages (paged).",
  inputSchema: requestDetailInput,
  run: async (args, archive) => buildRequestDetail(await archive.open(), archive.path, args)
});

export async function buildRequestDetail(
  player: WebBlackboxPlayer,
  archivePath: string,
  args: RequestDetailArgs
): Promise<ArchiveToolOutput> {
  const entry = player.getNetworkWaterfall().find((item) => item.reqId === args.requestId) ?? null;
  const realtime = player
    .getRealtimeNetworkTimeline()
    .filter((item) => item.streamId === args.requestId);

  if (!entry && realtime.length === 0) {
    throw new Error(
      `Unknown requestId '${args.requestId}': take ids from timeline, network_issues or ` +
        "summarize_actions."
    );
  }

  const events = player.getRequestEvents(args.requestId);
  const bodies = args.bodies ?? "both";
  const maxBodyBytes = args.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const { initiator, ...connection } = readRequestConnection(events);
  const span = entry?.actionId ? findActionSpan(player, entry.actionId) : null;
  const spanByTime = entry ? findActionByTime(player, entry.startMono) : null;
  const wantsRequestBody = bodies === "both" || bodies === "request";
  const wantsResponseBody = bodies === "both" || bodies === "response";

  return {
    data: {
      archive: archivePath,
      request: entry ? describeEntry(entry) : { requestId: args.requestId },
      connection,
      timing: readRequestTiming(events),
      initiator: initiator
        ? { ...initiator, frames: capList(initiator.frames, INITIATOR_FRAME_LIMIT) }
        : null,
      redirects: events.filter((event) => event.type === "network.redirect").map(describeRedirect),
      requestHeaders: capHeaders(entry?.requestHeaders ?? {}),
      responseHeaders: capHeaders(entry?.responseHeaders ?? {}),
      requestBody: entry && wantsRequestBody ? viewRequestBody(entry, maxBodyBytes) : null,
      responseBody:
        entry && wantsResponseBody ? await viewResponseBody(player, entry, maxBodyBytes) : null,
      linkedAction: span && entry ? describeAction(span, entry) : null,
      /**
       * The action whose time window (after its trigger, before the next action, at most 1.5 s)
       * the request started in. The recorder links by arrival order, so `linkedAction` can be the
       * neighbouring action or missing.
       */
      actionByTime: spanByTime && entry ? describeAction(spanByTime, entry) : null,
      // Socket messages are paged under `frames`; the lifecycle events stay listed here.
      events: capList(
        events
          .filter((event) => !REALTIME_MESSAGE_TYPES.has(event.type))
          .map((event) => ({ eventId: event.id, type: event.type, mono: event.mono })),
        EVENT_LIMIT
      ),
      frames: realtime.length > 0 ? await pageFrames(player, realtime, args) : null
    }
  };
}

function describeAction(span: ActionSpan, entry: NetworkWaterfallEntry): Record<string, unknown> {
  return {
    actionId: span.actId,
    triggerEventId: span.triggerEventId,
    startMono: span.startMono,
    offsetMs: round2(entry.startMono - span.startMono)
  };
}

function describeEntry(entry: NetworkWaterfallEntry): Record<string, unknown> {
  return {
    requestId: entry.reqId,
    method: entry.method,
    url: capValue(entry.url, URL_MAX_BYTES),
    status: entry.status ?? null,
    statusText: entry.statusText ?? null,
    mimeType: entry.mimeType ?? null,
    failed: entry.failed,
    errorText: entry.errorText ?? null,
    pending: entry.pending === true,
    fromCache: entry.fromCache ?? null,
    startMono: entry.startMono,
    endMono: entry.endMono,
    durationMs: round2(entry.durationMs),
    startWallTime: entry.startWallTime,
    encodedDataLength: entry.encodedDataLength ?? null
  };
}

function describeRedirect(event: WebBlackboxEvent): Record<string, unknown> {
  const data = asRecord(event.data);
  const response = asRecord(data?.redirectResponse) ?? asRecord(data?.response);

  const url = asString(data?.url) ?? asString(asRecord(data?.request)?.url);
  const location = asString(data?.redirectUrl) ?? asString(data?.location);

  return {
    eventId: event.id,
    mono: event.mono,
    url: url === undefined ? null : capValue(url, URL_MAX_BYTES),
    status: asNumber(data?.status) ?? asNumber(response?.status) ?? null,
    location: location === undefined ? null : capValue(location, URL_MAX_BYTES)
  };
}

/** The value, or its first `maxBytes` followed by `… (N of M bytes)`. */
function capValue(value: string, maxBytes: number): string {
  const cut = cutText(value, maxBytes);
  return cut.truncated ? `${cut.text}… (${cut.note})` : value;
}

function capHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, capValue(value, HEADER_VALUE_MAX_BYTES)])
  );
}

function viewRequestBody(entry: NetworkWaterfallEntry, maxBytes: number): BodyView {
  const mimeType = entry.requestHeaders["content-type"] ?? null;

  if (entry.requestBodyText !== undefined) {
    return viewBodyText(entry.requestBodyText, {
      mimeType,
      originalBytes: null,
      capturedPrefixOnly: entry.requestBodyTruncated === true,
      maxBytes
    });
  }

  if (entry.requestBodySkipReason) {
    return missingBody(mimeType, `Not recorded: ${entry.requestBodySkipReason}.`);
  }

  return missingBody(
    mimeType,
    entry.requestHasBody
      ? "The request had a body, but the archive does not hold it."
      : "The request had no body."
  );
}

async function viewResponseBody(
  player: WebBlackboxPlayer,
  entry: NetworkWaterfallEntry,
  maxBytes: number
): Promise<BodyView> {
  const mimeType = entry.mimeType ?? null;

  if (!entry.responseBodyHash) {
    return missingBody(mimeType, describeResponseSkip(entry));
  }

  const blob = await player.getBlob(entry.responseBodyHash);

  if (!blob) {
    return missingBody(
      mimeType,
      `Body blob ${entry.responseBodyHash} is missing from the archive.`
    );
  }

  return viewBodyBytes(blob.bytes, {
    mimeType: mimeType ?? blob.mime,
    originalBytes: entry.responseBodySize ?? null,
    capturedPrefixOnly: entry.responseBodyTruncated === true,
    maxBytes
  });
}

function describeResponseSkip(entry: NetworkWaterfallEntry): string {
  const skip = entry.responseBodySkip;

  if (!skip) {
    return "The archive holds no response body (the capture mode or profile did not record it).";
  }

  const facts = [
    skip.detail,
    skip.size === undefined ? undefined : `${skip.size} bytes`,
    skip.limit === undefined ? undefined : `limit ${skip.limit}`
  ].filter((fact): fact is string => Boolean(fact));

  return `Not recorded: ${skip.reason}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}.`;
}

async function pageFrames(
  player: WebBlackboxPlayer,
  realtime: readonly RealtimeNetworkEntry[],
  args: RequestDetailArgs
): Promise<Record<string, unknown>> {
  const maxFrameBytes = args.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const url = realtime.find((frame) => frame.url)?.url;
  const offset = Math.min(decodeCursor(args.frameCursor), realtime.length);
  const described = await Promise.all(
    realtime
      .slice(offset, offset + (args.frameLimit ?? DEFAULT_FRAME_LIMIT))
      .map((frame) => describeFrame(player, frame, maxFrameBytes))
  );
  // The page budget counts the payloads as returned, not the recorded previews.
  const fitted = fitRows(described, FRAMES_PAGE_MAX_BYTES);
  const next = offset + fitted.rows.length;
  const hasMore = next < realtime.length;

  return {
    protocol: realtime[0]?.protocol ?? null,
    url: url ? capValue(url, URL_MAX_BYTES) : null,
    total: realtime.length,
    offset,
    truncated: hasMore,
    nextCursor: hasMore ? encodeCursor(next) : null,
    items: fitted.rows
  };
}

async function describeFrame(
  player: WebBlackboxPlayer,
  frame: RealtimeNetworkEntry,
  maxBytes: number
): Promise<Record<string, unknown>> {
  let payload: string | null = frame.payloadPreview ?? null;
  let payloadError: string | null = null;

  if (frame.payloadHash) {
    try {
      payload = await player.getRealtimePayloadText(frame.eventId);
    } catch (error) {
      payloadError = error instanceof Error ? error.message : String(error);
    }
  }

  const cut = payload === null ? null : cutText(payload, maxBytes);

  return {
    eventId: frame.eventId,
    type: frame.eventType,
    mono: frame.mono,
    direction: frame.direction ?? null,
    phase: frame.phase ?? null,
    opcode: frame.opcode ?? null,
    payloadLength: frame.payloadLength ?? null,
    payload: cut?.text ?? null,
    truncated: cut?.truncated ?? false,
    note: cut?.note ?? null,
    capturedPrefixOnly: frame.payloadTruncated === true,
    payloadError
  };
}
