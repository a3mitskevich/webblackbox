import {
  describeEventPhrase,
  toConsoleEntry,
  type NetworkWaterfallEntry,
  type WebBlackboxPlayer
} from "@webblackbox/player-sdk";
import { extractRequestId, type WebBlackboxEvent } from "@webblackbox/protocol";
import * as z from "zod";

import { requireEvent } from "./archive-lookup.js";
import { paginate } from "./budget.js";
import { defineArchiveTool, type ArchiveToolOutput } from "./registry.js";
import { asNumber, asRecord, asString, compactLabel, round2, withoutEmpty } from "./values.js";

export const TIMELINE_KINDS = [
  "action",
  "pointer",
  "navigation",
  "network",
  "realtime",
  "console",
  "error",
  "storage",
  "dom",
  "screen",
  "perf",
  "meta"
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** Pointer noise (moves, hovers, scrolls) is left out unless asked for. */
const DEFAULT_KINDS: readonly TimelineKind[] = TIMELINE_KINDS.filter((kind) => kind !== "pointer");
const POINTER_TYPES = new Set([
  "user.mousemove",
  "user.pointerdown",
  "user.pointerup",
  "user.hover",
  "user.scroll",
  "user.wheel",
  "user.selection",
  "user.click.reaction"
]);
/** Video chunks tell a reader nothing; the recording start/end rows do. */
const SKIPPED_TYPES = new Set(["screen.recording.chunk"]);
const KIND_BY_PREFIX: Readonly<Record<string, TimelineKind>> = {
  nav: "navigation",
  network: "network",
  console: "console",
  error: "error",
  storage: "storage",
  dom: "dom",
  screen: "screen",
  perf: "perf"
};
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_MAX_BYTES = 32_000;
const MIN_MAX_BYTES = 2_000;
const MAX_MAX_BYTES = 512_000;
const DEFAULT_WINDOW_MS = 5_000;
const MAX_WINDOW_MS = 600_000;
const SUMMARY_CHARS = 200;
const PAYLOAD_PREVIEW_CHARS = 80;

export const timelineInput = {
  monoStart: z.number().finite().optional().describe("Window start (mono ms)."),
  monoEnd: z.number().finite().optional().describe("Window end (mono ms)."),
  aroundEventId: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Center the window on this event (± windowMs) instead of monoStart/monoEnd."),
  aroundMono: z
    .number()
    .finite()
    .optional()
    .describe("Center the window on this time (± windowMs)."),
  windowMs: z
    .number()
    .finite()
    .min(1)
    .max(MAX_WINDOW_MS)
    .optional()
    .describe(`Half-width of an around-window (default ${DEFAULT_WINDOW_MS}).`),
  kinds: z
    .array(z.enum(TIMELINE_KINDS))
    .min(1)
    .max(TIMELINE_KINDS.length)
    .optional()
    .describe(`Row kinds to list (default all but pointer): ${TIMELINE_KINDS.join(", ")}.`),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Rows per page (default ${DEFAULT_LIMIT}).`),
  cursor: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe("`nextCursor` of a previous call with the same arguments."),
  maxBytes: z
    .number()
    .int()
    .min(MIN_MAX_BYTES)
    .max(MAX_MAX_BYTES)
    .optional()
    .describe(`Size budget of the rows (default ${DEFAULT_MAX_BYTES}).`)
};

export type TimelineArgs = {
  monoStart?: number;
  monoEnd?: number;
  aroundEventId?: string;
  aroundMono?: number;
  windowMs?: number;
  kinds?: TimelineKind[];
  limit?: number;
  cursor?: string;
  maxBytes?: number;
};

export type TimelineRow = {
  mono: number;
  kind: TimelineKind;
  type: string;
  eventId: string;
  summary: string;
  requestId?: string;
  actionId?: string;
  level?: string;
  status?: number;
  failed?: boolean;
  durationMs?: number;
};

export const timelineTool = defineArchiveTool({
  name: "timeline",
  description:
    "Compact chronological list of what happened in a time window — actions, network (one row " +
    "per request), console, errors, navigation, storage, DOM, screenshots, sockets — each row " +
    "with eventId / requestId / actionId to drill down. Window by monoStart/monoEnd or around an " +
    "event; paged with limit/cursor and a maxBytes budget.",
  inputSchema: timelineInput,
  run: async (args, archive) => buildTimeline(await archive.open(), archive.path, args)
});

export function buildTimeline(
  player: WebBlackboxPlayer,
  archivePath: string,
  args: TimelineArgs
): ArchiveToolOutput {
  const window = resolveWindow(player, args);
  const kinds = new Set<TimelineKind>(args.kinds ?? DEFAULT_KINDS);
  const waterfall = new Map(player.getNetworkWaterfall().map((entry) => [entry.reqId, entry]));
  const siteOrigin = player.archive.manifest.site.origin;
  const listedRequests = new Set<string>();
  const countsByKind: Partial<Record<TimelineKind, number>> = {};
  const rows: TimelineRow[] = [];

  for (const event of player.query({ range: window })) {
    const kind = kindOf(event);

    if (!kind) {
      continue;
    }

    const requestId = extractRequestId(event) ?? undefined;

    // One row per request: its first event in the window stands for the whole lifecycle.
    if (kind === "network" && requestId) {
      if (listedRequests.has(requestId)) {
        continue;
      }

      listedRequests.add(requestId);
    }

    countsByKind[kind] = (countsByKind[kind] ?? 0) + 1;

    if (kinds.has(kind)) {
      rows.push(toRow(event, kind, requestId, waterfall, siteOrigin));
    }
  }

  const page = paginate(rows, {
    cursor: args.cursor,
    limit: args.limit ?? DEFAULT_LIMIT,
    maxBytes: args.maxBytes ?? DEFAULT_MAX_BYTES
  });

  return {
    data: {
      archive: archivePath,
      window,
      kinds: [...kinds],
      countsByKind,
      total: page.total,
      offset: page.offset,
      returned: page.rows.length,
      truncated: page.truncated,
      nextCursor: page.nextCursor,
      rows: page.rows
    }
  };
}

type TimelineWindow = { monoStart?: number; monoEnd?: number };

function resolveWindow(player: WebBlackboxPlayer, args: TimelineArgs): TimelineWindow {
  const windowMs = args.windowMs ?? DEFAULT_WINDOW_MS;
  const hasAround = args.aroundEventId !== undefined || args.aroundMono !== undefined;
  const hasRange = args.monoStart !== undefined || args.monoEnd !== undefined;

  if (hasAround && hasRange) {
    throw new Error("Give either an around-anchor or monoStart/monoEnd, not both.");
  }

  if (args.aroundEventId !== undefined && args.aroundMono !== undefined) {
    throw new Error("Give aroundEventId or aroundMono, not both.");
  }

  if (hasAround) {
    const center =
      args.aroundEventId !== undefined
        ? requireEvent(player, args.aroundEventId).mono
        : (args.aroundMono ?? 0);
    return { monoStart: center - windowMs, monoEnd: center + windowMs };
  }

  if (args.monoStart !== undefined && args.monoEnd !== undefined && args.monoEnd < args.monoStart) {
    throw new Error("monoEnd is before monoStart.");
  }

  return withoutEmpty({ monoStart: args.monoStart, monoEnd: args.monoEnd });
}

export function kindOf(event: WebBlackboxEvent): TimelineKind | null {
  const { type } = event;

  if (SKIPPED_TYPES.has(type)) {
    return null;
  }

  if (type.startsWith("user.")) {
    return POINTER_TYPES.has(type) ? "pointer" : "action";
  }

  if (type.startsWith("network.ws.") || type.startsWith("network.sse.")) {
    return "realtime";
  }

  return KIND_BY_PREFIX[type.slice(0, type.indexOf("."))] ?? "meta";
}

function toRow(
  event: WebBlackboxEvent,
  kind: TimelineKind,
  requestId: string | undefined,
  waterfall: ReadonlyMap<string, NetworkWaterfallEntry>,
  siteOrigin: string
): TimelineRow {
  const base: TimelineRow = {
    mono: event.mono,
    kind,
    type: event.type,
    eventId: event.id,
    summary: "",
    ...withoutEmpty({ requestId, actionId: event.ref?.act })
  };
  const entry = requestId ? waterfall.get(requestId) : undefined;

  if (kind === "network" && entry) {
    return {
      ...base,
      summary: summarizeRequest(entry),
      ...withoutEmpty({
        status: entry.status,
        failed: entry.failed || undefined,
        durationMs: round2(entry.durationMs),
        actionId: base.actionId ?? entry.actionId
      })
    };
  }

  if (kind === "console" || kind === "error") {
    const consoleEntry = toConsoleEntry(event, { siteOrigin });
    return {
      ...base,
      ...withoutEmpty({ level: consoleEntry?.level ?? event.lvl }),
      summary: compactLabel(consoleEntry?.message ?? event.type, SUMMARY_CHARS)
    };
  }

  return { ...base, summary: compactLabel(summarizeEvent(event, kind), SUMMARY_CHARS) };
}

function summarizeRequest(entry: NetworkWaterfallEntry): string {
  const outcome =
    entry.status !== undefined
      ? String(entry.status)
      : entry.failed
        ? `failed${entry.errorText ? ` (${entry.errorText})` : ""}`
        : entry.pending
          ? "pending"
          : "no status";

  return compactLabel(
    `${entry.method} ${outcome} ${entry.url} (${round2(entry.durationMs)} ms)`,
    SUMMARY_CHARS
  );
}

function joinParts(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function summarizeEvent(event: WebBlackboxEvent, kind: TimelineKind): string {
  const data = asRecord(event.data);

  switch (kind) {
    case "action": {
      const phrase = describeEventPhrase(event);
      return joinParts([phrase.verb, phrase.target ? `"${phrase.target}"` : null, phrase.detail]);
    }
    case "navigation":
      return joinParts([event.type.slice("nav.".length), asString(data?.url)]);
    case "realtime": {
      const frame = asRecord(data?.frame);
      const preview =
        asString(frame?.payloadPreview) ?? asString(data?.data) ?? asString(data?.url) ?? "";
      return joinParts([
        event.type.slice("network.".length),
        asString(data?.direction),
        compactLabel(preview, PAYLOAD_PREVIEW_CHARS)
      ]);
    }
    case "screen":
      return event.type === "screen.screenshot"
        ? joinParts(["screenshot", asString(data?.reason)])
        : event.type.slice("screen.".length);
    case "dom": {
      const count = asNumber(data?.count);
      return count === undefined ? event.type : `${event.type} (${count} changes)`;
    }
    case "perf": {
      const value = asNumber(data?.value) ?? asNumber(data?.duration);
      return joinParts([
        event.type,
        asString(data?.metric) ?? asString(data?.name),
        value === undefined ? null : String(round2(value))
      ]);
    }
    case "storage":
      return joinParts([
        event.type,
        asString(data?.op),
        asString(data?.key) ?? asString(data?.name)
      ]);
    default:
      return event.type;
  }
}
