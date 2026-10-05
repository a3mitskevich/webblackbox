import {
  buildRealtimeStreams,
  isThirdPartyUrl,
  maskSensitiveUrl,
  type NetworkWaterfallEntry,
  type RealtimeStream
} from "@webblackbox/player-sdk";

import type { Selection } from "../../../core/navigation.js";
import type { PlayerLocale } from "../../../lib/i18n.js";
import { describeRequestName, resolveNetworkInitiator } from "../../../lib/network-labels.js";
import { resolveNetworkSizeBytes } from "../../../lib/network-size.js";
import {
  applyNetworkViewFilters,
  networkStatusCode,
  resolveNetworkTypeBucket,
  type NetworkSortDirection,
  type NetworkSortKey
} from "../../../lib/network-view.js";
import type { LoadedArchive } from "../../state.js";

/**
 * The rows of the Network table: HTTP requests from the waterfall plus one row per WebSocket
 * (sockets have no `network.request`). An SSE stream rides on its HTTP request's row.
 */
export type NetworkRow =
  | {
      kind: "http";
      id: string;
      startMono: number;
      durationMs: number;
      entry: NetworkWaterfallEntry;
      /** The SSE messages of an `text/event-stream` request. */
      stream?: RealtimeStream;
    }
  | {
      kind: "socket";
      id: string;
      startMono: number;
      durationMs: number;
      stream: RealtimeStream;
    };

/** Type chips of the toolbar (one at a time). */
export const NETWORK_TYPE_CHIPS = ["all", "fetch", "document", "script", "image", "ws"] as const;
export type NetworkTypeChip = (typeof NETWORK_TYPE_CHIPS)[number];

export type NetworkFilters = {
  query: string;
  type: NetworkTypeChip;
  failedOnly: boolean;
  notCapturedOnly: boolean;
  hideThirdParty: boolean;
};

export type NetworkSort = { key: NetworkSortKey; direction: NetworkSortDirection };

export type NetworkModel = {
  /** Every row, by start time. */
  rows: NetworkRow[];
  rowById: Map<string, NetworkRow>;
  streams: RealtimeStream[];
  /** Stream of every realtime event (open, frames, close, SSE messages). */
  streamByEventId: Map<string, RealtimeStream>;
  /** Request id of every network event (request, response, body, …). */
  requestByEventId: Map<string, string>;
  /** Recording origin: first party for "Hide third-party". */
  origin: string;
  /** Session span the waterfall bars are drawn on. */
  minMono: number;
  durationMono: number;
};

const models = new WeakMap<LoadedArchive, NetworkModel>();

/** The network model of an archive, built once per archive. */
export function getNetworkModel(archive: LoadedArchive): NetworkModel {
  const cached = models.get(archive);

  if (cached) {
    return cached;
  }

  const model = buildNetworkModel(
    archive.model.waterfall,
    buildRealtimeStreams(archive.model.realtime),
    {
      origin: archive.view.meta.origin,
      minMono: archive.model.minMono,
      durationMono: archive.model.durationMono
    }
  );
  models.set(archive, model);
  return model;
}

export function buildNetworkModel(
  waterfall: readonly NetworkWaterfallEntry[],
  streams: readonly RealtimeStream[],
  session: { origin: string; minMono: number; durationMono: number }
): NetworkModel {
  const reqIds = new Set(waterfall.map((entry) => entry.reqId));
  const sseByReqId = new Map(
    streams
      .filter((stream) => stream.protocol === "sse" && reqIds.has(stream.streamId))
      .map((stream) => [stream.streamId, stream])
  );
  const httpRows: NetworkRow[] = waterfall.map((entry) => {
    const stream = sseByReqId.get(entry.reqId);
    return {
      kind: "http",
      id: entry.reqId,
      startMono: entry.startMono,
      durationMs: entry.durationMs,
      entry,
      ...(stream ? { stream } : {})
    };
  });
  const socketRows: NetworkRow[] = streams
    .filter((stream) => !sseByReqId.has(stream.streamId) || stream.protocol === "ws")
    .map((stream) => {
      const startMono = stream.openMono ?? stream.firstMono;
      return {
        kind: "socket",
        id: socketRowId(stream),
        startMono,
        durationMs: Math.max(0, (stream.closeMono ?? stream.lastMono) - startMono),
        stream
      };
    });
  const rows = [...httpRows, ...socketRows].sort((left, right) => left.startMono - right.startMono);
  const streamByEventId = new Map<string, RealtimeStream>();

  for (const stream of streams) {
    for (const eventId of streamEventIds(stream)) {
      streamByEventId.set(eventId, stream);
    }
  }

  const requestByEventId = new Map<string, string>();

  for (const entry of waterfall) {
    for (const eventId of entry.eventIds) {
      requestByEventId.set(eventId, entry.reqId);
    }
  }

  return {
    rows,
    rowById: new Map(rows.map((row) => [row.id, row])),
    streams: [...streams],
    streamByEventId,
    requestByEventId,
    origin: session.origin,
    minMono: session.minMono,
    durationMono: session.durationMono
  };
}

/** Socket rows are keyed apart from request ids (a socket may reuse a request's id space). */
export function socketRowId(stream: RealtimeStream): string {
  return `${stream.protocol}:${stream.streamId}`;
}

function streamEventIds(stream: RealtimeStream): string[] {
  return [
    ...(stream.openEventId ? [stream.openEventId] : []),
    ...stream.messages.map((message) => message.eventId),
    ...(stream.closeEventId ? [stream.closeEventId] : [])
  ];
}

/** The event that stands for a socket in the player-wide selection (its open, or first message). */
export function socketSelection(stream: RealtimeStream): Selection | null {
  const id = stream.openEventId ?? stream.messages[0]?.eventId ?? stream.closeEventId;
  return id ? { kind: "event", id } : null;
}

/** The stream a selected event belongs to, if any. */
export function streamOfSelection(
  model: NetworkModel,
  selection: Selection | null
): RealtimeStream | null {
  return selection?.kind === "event" ? (model.streamByEventId.get(selection.id) ?? null) : null;
}

/** The row the selection points at: a request, or any event of a socket or SSE stream. */
export function rowOfSelection(
  model: NetworkModel,
  selection: Selection | null
): NetworkRow | null {
  if (selection?.kind === "request") {
    return model.rowById.get(selection.id) ?? null;
  }

  const stream = streamOfSelection(model, selection);

  if (!stream) {
    const reqId =
      selection?.kind === "event" ? model.requestByEventId.get(selection.id) : undefined;
    return reqId ? (model.rowById.get(reqId) ?? null) : null;
  }

  return (
    model.rowById.get(socketRowId(stream)) ??
    (stream.protocol === "sse" ? model.rowById.get(stream.streamId) : undefined) ??
    null
  );
}

export function selectionOfRow(row: NetworkRow): Selection | null {
  return row.kind === "http"
    ? { kind: "request", id: row.entry.reqId }
    : socketSelection(row.stream);
}

/** `A-000003` → `A-3` (the mockups' Action column). */
export function shortActionId(actionId: string): string {
  const number = /(\d+)$/.exec(actionId)?.[1];
  return number ? `A-${Number(number)}` : actionId;
}

/** Name and host for the table: secret query values hidden, the `…` mask kept readable. */
export function displayName(url: string): { name: string; host: string } {
  const name = describeRequestName(maskSensitiveUrl(url).url);

  try {
    return { ...name, name: decodeURIComponent(name.name) };
  } catch {
    return name;
  }
}

/** A socket by its path (`/proxy-live/hubs`): the query only holds tokens. `null` without a URL. */
export function socketPath(stream: RealtimeStream): { path: string; host: string } | null {
  if (!stream.url) {
    return null;
  }

  try {
    const url = new URL(stream.url);
    return { path: url.pathname, host: url.host };
  } catch {
    return { path: stream.url.split("?")[0] ?? stream.url, host: "" };
  }
}

export function rowUrl(row: NetworkRow): string {
  return row.kind === "http" ? row.entry.url : (row.stream.url ?? "");
}

export function isRowFailed(row: NetworkRow): boolean {
  if (row.kind === "socket") {
    return false;
  }

  return row.entry.failed || (typeof row.entry.status === "number" && row.entry.status >= 400);
}

/** A response or request body the capture asked for and did not keep. */
export function isRowNotCaptured(row: NetworkRow): boolean {
  return (
    row.kind === "http" &&
    (row.entry.responseBodySkip !== undefined || row.entry.requestBodySkipReason !== undefined)
  );
}

/** A body (or socket frame) the recorder cut at the profile limit. */
export function isRowCut(row: NetworkRow): boolean {
  return row.kind === "http"
    ? row.entry.responseBodyTruncated === true || row.entry.requestBodyTruncated === true
    : row.stream.truncated > 0;
}

export function rowTypeChip(row: NetworkRow): Exclude<NetworkTypeChip, "all"> | "other" {
  if (row.kind === "socket") {
    return "ws";
  }

  const bucket = resolveNetworkTypeBucket(row.entry.mimeType);
  return bucket === "fetch" || bucket === "document" || bucket === "script" || bucket === "image"
    ? bucket
    : "other";
}

export function isRowThirdParty(model: NetworkModel, row: NetworkRow): boolean {
  return isThirdPartyUrl(rowUrl(row), model.origin);
}

/** Rows that pass the text filter and "Hide third-party": the base of the chip counts. */
export function filterBaseRows(
  model: NetworkModel,
  filters: Pick<NetworkFilters, "query" | "hideThirdParty">,
  locale: PlayerLocale
): NetworkRow[] {
  const query = filters.query.trim().toLowerCase();
  const view = { query, method: "all", status: "all", type: "all" } as const;

  return model.rows.filter((row) => {
    if (filters.hideThirdParty && isRowThirdParty(model, row)) {
      return false;
    }

    if (!query) {
      return true;
    }

    if (row.kind === "http") {
      return applyNetworkViewFilters([row.entry], view, locale).length === 1;
    }

    return `${row.stream.streamId} ${row.stream.url ?? ""} websocket ws`
      .toLowerCase()
      .includes(query);
  });
}

export type NetworkCounts = Record<NetworkTypeChip | "failed" | "notCaptured", number>;

export type NetworkView = {
  rows: NetworkRow[];
  /** Rows per chip and toggle, over the base rows (text filter + third-party). */
  counts: NetworkCounts;
  /** Third-party rows "Hide third-party" removed. */
  hiddenThirdParty: number;
};

/** The visible rows: base rows → type chip → Failed / Not captured, sorted. */
export function buildNetworkView(
  model: NetworkModel,
  filters: NetworkFilters,
  sort: NetworkSort,
  locale: PlayerLocale
): NetworkView {
  const base = filterBaseRows(model, filters, locale);
  const counts: NetworkCounts = {
    all: base.length,
    fetch: 0,
    document: 0,
    script: 0,
    image: 0,
    ws: 0,
    failed: 0,
    notCaptured: 0
  };

  for (const row of base) {
    const chip = rowTypeChip(row);

    if (chip !== "other") {
      counts[chip] += 1;
    }

    counts.failed += isRowFailed(row) ? 1 : 0;
    counts.notCaptured += isRowNotCaptured(row) || isRowCut(row) ? 1 : 0;
  }

  const rows = base.filter(
    (row) =>
      (filters.type === "all" || rowTypeChip(row) === filters.type) &&
      (!filters.failedOnly || isRowFailed(row)) &&
      (!filters.notCapturedOnly || isRowNotCaptured(row) || isRowCut(row))
  );
  const hiddenThirdParty = filters.hideThirdParty
    ? filterBaseRows(model, { ...filters, hideThirdParty: false }, locale).length - base.length
    : 0;

  return { rows: sortRows(rows, sort, locale), counts, hiddenThirdParty };
}

/** Stable sort by one column (ties keep the start-time order). */
export function sortRows(
  rows: readonly NetworkRow[],
  sort: NetworkSort,
  locale: PlayerLocale
): NetworkRow[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  const keyed = rows.map((row, index) => ({ row, index, key: sortValue(row, sort.key, locale) }));

  keyed.sort((left, right) => {
    const order =
      typeof left.key === "number" && typeof right.key === "number"
        ? left.key - right.key
        : String(left.key).localeCompare(String(right.key), locale);
    return order !== 0 ? order * direction : left.index - right.index;
  });

  return keyed.map((item) => item.row);
}

function sortValue(row: NetworkRow, key: NetworkSortKey, locale: PlayerLocale): number | string {
  switch (key) {
    case "start":
      return row.startMono;
    case "time":
      return row.durationMs;
    case "name":
      return describeRequestName(rowUrl(row)).name;
    case "method":
      return row.kind === "http" ? row.entry.method.toUpperCase() : "GET";
    case "status":
      return row.kind === "http" ? networkStatusCode(row.entry) : 101;
    case "type":
      return rowTypeChip(row);
    case "initiator":
      return row.kind === "http" ? resolveNetworkInitiator(row.entry, locale) : "";
    case "size":
      return row.kind === "http"
        ? resolveNetworkSizeBytes(row.entry)
        : row.stream.sentBytes + row.stream.receivedBytes;
  }
}

/**
 * The row the list follows while playing: the latest-starting row at or before the playhead
 * (whatever the sort), or -1 before the first request.
 */
export function followIndex(rows: readonly NetworkRow[], playheadMono: number): number {
  let index = -1;
  let latest = Number.NEGATIVE_INFINITY;

  for (const [position, row] of rows.entries()) {
    if (row.startMono <= playheadMono && row.startMono >= latest) {
      index = position;
      latest = row.startMono;
    }
  }

  return index;
}

/** The slowest HTTP request (classic "Jump to slowest request"). */
export function findSlowestRow(rows: readonly NetworkRow[]): NetworkRow | null {
  return rows.reduce<NetworkRow | null>(
    (slowest, row) =>
      row.kind === "http" && (!slowest || row.durationMs > slowest.durationMs) ? row : slowest,
    null
  );
}
