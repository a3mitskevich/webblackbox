import {
  describeEventPhrase,
  findClickReaction,
  inspectEventTarget,
  isMaskedValue,
  summarizeActionConsequences,
  toConsoleEntry,
  type ActionSpan,
  type NetworkWaterfallEntry,
  type WebBlackboxPlayer
} from "@webblackbox/player-sdk";
import { extractRequestId, type WebBlackboxEvent } from "@webblackbox/protocol";
import * as z from "zod";

import {
  findNearestScreenshots,
  listScreenshots,
  requireActionSpan,
  toScreenshotPointer
} from "./archive-lookup.js";
import { capList, cutText, shrinkListsToBudget } from "./budget.js";
import { defineArchiveTool, type ArchiveToolOutput } from "./registry.js";
import { asNumber, asRecord, asString, compactLabel, round2 } from "./values.js";

const DEFAULT_LIMIT = 10;
/** The consequence summary stays short: the lists below hold the full detail. */
const CONSEQUENCE_ITEMS = 8;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 24_000;
const MIN_MAX_BYTES = 4_000;
const MAX_MAX_BYTES = 256_000;
const RAW_TARGET_MAX_BYTES = 4_000;
const DOM_SUMMARY_MAX_BYTES = 600;
const LABEL_CHARS = 300;
const VALUE_CHARS = 200;

export const actionDetailInput = {
  actionId: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Action id (`actionId` in timeline rows, `actId` in summarize_actions); an event id " +
        "resolves to the action that holds it."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum items per linked list (default ${DEFAULT_LIMIT}).`),
  maxBytes: z
    .number()
    .int()
    .min(MIN_MAX_BYTES)
    .max(MAX_MAX_BYTES)
    .optional()
    .describe(`Size budget of the JSON result (default ${DEFAULT_MAX_BYTES}).`),
  includeRawTarget: z
    .boolean()
    .optional()
    .describe("Include the target object exactly as recorded (default true, capped at 4 KB).")
};

export type ActionDetailArgs = {
  actionId: string;
  limit?: number;
  maxBytes?: number;
  includeRawTarget?: boolean;
};

export const actionDetailTool = defineArchiveTool({
  name: "action_detail",
  description:
    "Everything about one user action: the trigger, the full target as recorded (tag, role, " +
    "text/label, selector candidates, rect, frame), modifiers, whether the DOM reacted, and the " +
    "requests, errors, console, DOM changes and navigations it caused, with ids to drill down " +
    "(request_detail, frame_at).",
  inputSchema: actionDetailInput,
  run: async (args, archive) => buildActionDetail(await archive.open(), archive.path, args)
});

export function buildActionDetail(
  player: WebBlackboxPlayer,
  archivePath: string,
  args: ActionDetailArgs
): ArchiveToolOutput {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const span = requireActionSpan(player, args.actionId);
  const eventsById = new Map(player.events.map((event) => [event.id, event]));
  const spanEvents = span.eventIds
    .map((eventId) => eventsById.get(eventId))
    .filter((event): event is WebBlackboxEvent => event !== undefined)
    .sort((left, right) => left.mono - right.mono);
  const trigger = eventsById.get(span.triggerEventId) ?? null;
  const requests = findActionRequests(player.getNetworkWaterfall(), span, spanEvents);
  const siteOrigin = player.archive.manifest.site.origin;
  const consoleRows = spanEvents
    .map((event) => toConsoleEntry(event, { siteOrigin }))
    .filter((entry) => entry !== null);
  const shots = findNearestScreenshots(listScreenshots(player), span.startMono);
  const offsetOf = (mono: number): number => round2(mono - span.startMono);
  const data: Record<string, unknown> = {
    archive: archivePath,
    action: {
      actionId: span.actId,
      startMono: span.startMono,
      endMono: span.endMono,
      durationMs: round2(span.endMono - span.startMono),
      eventCount: span.eventIds.length,
      /** Grouped by time after the trigger, not linked by the recorder (`ref.act`). */
      derived: span.actId.startsWith("derived:")
    },
    trigger: trigger ? describeTrigger(trigger) : null,
    target: trigger ? describeTarget(trigger, args.includeRawTarget !== false) : null,
    reaction: trigger?.type === "user.click" ? findClickReaction(player.events, trigger) : null,
    consequences: summarizeActionConsequences({
      startMono: span.startMono,
      endMono: span.endMono,
      events: spanEvents,
      triggerEventId: span.triggerEventId,
      requests,
      maxItems: CONSEQUENCE_ITEMS
    }),
    requests: capList(
      requests.map((entry) => ({
        requestId: entry.reqId,
        method: entry.method,
        url: compactLabel(entry.url, LABEL_CHARS),
        status: entry.status ?? null,
        failed: entry.failed,
        offsetMs: offsetOf(entry.startMono),
        durationMs: round2(entry.durationMs)
      })),
      limit
    ),
    errors: capList(
      consoleRows
        .filter((entry) => entry.kind !== "console")
        .map((entry) => ({
          eventId: entry.eventId,
          kind: entry.kind,
          level: entry.level,
          offsetMs: offsetOf(entry.mono),
          message: compactLabel(entry.message, LABEL_CHARS)
        })),
      limit
    ),
    console: capList(
      consoleRows
        .filter((entry) => entry.kind === "console")
        .map((entry) => ({
          eventId: entry.eventId,
          level: entry.level,
          offsetMs: offsetOf(entry.mono),
          message: compactLabel(entry.message, LABEL_CHARS)
        })),
      limit
    ),
    dom: capList(
      spanEvents
        .filter((event) => event.type.startsWith("dom."))
        .map((event) => describeDomEvent(event, offsetOf(event.mono))),
      limit
    ),
    navigation: capList(
      spanEvents
        .filter((event) => event.type.startsWith("nav."))
        .map((event) => ({
          eventId: event.id,
          type: event.type,
          offsetMs: offsetOf(event.mono),
          url: compactLabel(asString(asRecord(event.data)?.url) ?? "", LABEL_CHARS)
        })),
      limit
    ),
    screenshots: {
      before: shots.before ? toScreenshotPointer(shots.before, span.startMono) : null,
      after: shots.after ? toScreenshotPointer(shots.after, span.startMono) : null
    },
    eventTypes: countTypes(spanEvents)
  };
  const truncatedLists = shrinkListsToBudget(data, args.maxBytes ?? DEFAULT_MAX_BYTES);

  return { data: { ...data, truncatedLists } };
}

function findActionRequests(
  waterfall: readonly NetworkWaterfallEntry[],
  span: ActionSpan,
  spanEvents: readonly WebBlackboxEvent[]
): NetworkWaterfallEntry[] {
  const requestIds = new Set(
    spanEvents.map((event) => extractRequestId(event)).filter((id): id is string => Boolean(id))
  );

  return waterfall
    .filter((entry) => entry.actionId === span.actId || requestIds.has(entry.reqId))
    .sort((left, right) => left.startMono - right.startMono);
}

function describeTrigger(event: WebBlackboxEvent): Record<string, unknown> {
  const data = asRecord(event.data);
  const value = asString(data?.value);

  return {
    eventId: event.id,
    type: event.type,
    mono: event.mono,
    t: event.t,
    tab: event.tab,
    frame: event.frame ?? null,
    nav: event.nav ?? null,
    phrase: describeEventPhrase(event),
    key: asString(data?.key) ?? asString(data?.code) ?? null,
    value: value === undefined ? null : compactLabel(value, VALUE_CHARS)
  };
}

function describeTarget(
  event: WebBlackboxEvent,
  includeRaw: boolean
): Record<string, unknown> | null {
  const inspected = inspectEventTarget(event);
  const raw = asRecord(asRecord(event.data)?.target);

  if (!inspected || !raw) {
    return null;
  }

  const readable = asRecord(raw.readable);
  const rawJson = includeRaw ? cutText(JSON.stringify(raw), RAW_TARGET_MAX_BYTES) : null;

  return {
    ...inspected,
    tag: asString(raw.tag)?.toLowerCase() ?? null,
    id: unmasked(asString(raw.idToken)),
    classes: Array.isArray(raw.classTokens)
      ? raw.classTokens.filter(
          (token): token is string => typeof token === "string" && !isMaskedValue(token)
        )
      : [],
    name: unmasked(asString(readable?.name)),
    ariaLabel: unmasked(asString(readable?.ariaLabel)),
    frame: event.frame ?? null,
    selectorCandidates: buildSelectorCandidates(raw, inspected),
    recorded: rawJson
      ? { json: rawJson.text, truncated: rawJson.truncated, note: rawJson.note }
      : null
  };
}

type SelectorCandidate = { kind: string; value: string };

/** Ways to find the target again, most stable first; hashed values are left out. */
function buildSelectorCandidates(
  raw: Record<string, unknown>,
  inspected: NonNullable<ReturnType<typeof inspectEventTarget>>
): SelectorCandidate[] {
  const readable = asRecord(raw.readable);
  const tag = asString(raw.tag)?.toLowerCase() ?? "*";
  const id = unmasked(asString(raw.idToken));
  const name = unmasked(asString(readable?.name));
  const ariaLabel = unmasked(asString(readable?.ariaLabel));
  const recordedSelector = unmasked(asString(raw.selector));
  const { role, text, testId, selector } = inspected;
  const candidates: Array<SelectorCandidate | null> = [
    testId ? { kind: "testId", value: `[data-testid=${quote(testId)}]` } : null,
    selector ? { kind: "css", value: selector } : null,
    id ? { kind: "id", value: `#${cssEscape(id)}` } : null,
    name ? { kind: "name", value: `${tag}[name=${quote(name)}]` } : null,
    ariaLabel ? { kind: "ariaLabel", value: `${tag}[aria-label=${quote(ariaLabel)}]` } : null,
    role && text
      ? { kind: "role", value: `getByRole(${quote(role)}, { name: ${quote(text)} })` }
      : null,
    text ? { kind: "text", value: `getByText(${quote(text)})` } : null,
    recordedSelector ? { kind: "recordedPath", value: recordedSelector } : null
  ];
  const seen = new Set<string>();

  return candidates.filter((candidate): candidate is SelectorCandidate => {
    if (!candidate || seen.has(candidate.value)) {
      return false;
    }

    seen.add(candidate.value);
    return true;
  });
}

function describeDomEvent(event: WebBlackboxEvent, offsetMs: number): Record<string, unknown> {
  const data = asRecord(event.data);
  const summary =
    data?.summary === undefined
      ? null
      : cutText(JSON.stringify(data.summary), DOM_SUMMARY_MAX_BYTES);

  return {
    eventId: event.id,
    type: event.type,
    offsetMs,
    count: asNumber(data?.count) ?? null,
    summary: summary?.text ?? null
  };
}

function countTypes(events: readonly WebBlackboxEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }

  return counts;
}

function unmasked(value: string | undefined): string | null {
  return value && !isMaskedValue(value) ? value : null;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}
