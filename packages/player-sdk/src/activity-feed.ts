import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { extractRequestId } from "@webblackbox/protocol";

import {
  isProblemEvent,
  isProblemRequest,
  readConsoleLevel,
  readEventResourceUrl,
  type ProblemRequest
} from "./problems.js";
import { isThirdPartyUrl } from "./third-party.js";

/** What an Activity feed row is about (PROPOSAL §9 B: "action → consequences"). */
export type ActivityItemKind =
  | "start"
  | "action"
  | "navigation"
  | "request"
  | "realtime"
  | "console"
  | "exception";

/** One feed item: an event worth a row, with its context. */
export type ActivityItem = {
  eventId: string;
  mono: number;
  kind: ActivityItemKind;
  /** Set when the event triggers a user action span: an action row, its consequences follow. */
  actId: string | null;
  /** The action span this event is a consequence of (`ref.act`); `null` for none. */
  parentActId: string | null;
  isProblem: boolean;
  /** A request, socket, console line or exception of a site other than the recorded one. */
  thirdParty: boolean;
  /** Request id of request rows. */
  reqId?: string;
  /** Consecutive items with the same key and parent collapse into one "×N" row. */
  repeatKey: string;
  /** Navigation rows: the route (`#/lobby`, `/cart`) and the how-many-th visit to it this is. */
  route?: string;
  visit?: number;
};

/** The action fields the feed reads (`ActionTimelineEntry` fits). */
export type ActivityAction = {
  actId: string;
  triggerEventId: string;
  /** Span bounds: an event without `ref.act` inside them is a consequence of the action. */
  startMono?: number;
  endMono?: number;
};

/** The request fields the feed reads (`NetworkWaterfallEntry` fits). */
export type ActivityRequest = ProblemRequest & {
  method?: string;
  /** The action span any of the request's events belongs to (`ref.act`). */
  actionId?: string;
};

export type ActivityFeedInput = {
  /** Events in timeline order. */
  events: readonly WebBlackboxEvent[];
  actions: readonly ActivityAction[];
  requests: readonly ActivityRequest[];
  /** The recorded page (`manifest.site.origin`). */
  firstPartyUrl: string;
};

/**
 * `curated`: actions, navigations, failed requests, socket opens and closes, console warnings and
 * errors, exceptions and the recording start. `all` adds every request and console line — the
 * feed uses it while a search is typed, so any URL or message can be found.
 */
export type ActivityScope = "curated" | "all";

type ItemTraits = Pick<
  ActivityItem,
  "kind" | "isProblem" | "thirdParty" | "repeatKey" | "route" | "reqId"
>;

const ACTION_TYPES = new Set([
  "user.click",
  "user.dblclick",
  "user.contextmenu",
  "user.auxclick",
  "user.submit",
  "user.input",
  "user.keydown",
  "user.marker",
  "user.drag.start",
  "user.visibility"
]);
/** Bursts of these collapse into one row; clicks keep a row each (they have consequences). */
const COLLAPSIBLE_ACTION_TYPES = new Set(["user.input", "user.keydown", "user.visibility"]);
const REALTIME_TYPES = new Set(["network.ws.open", "network.ws.close"]);
const NOTICE_CONSOLE_LEVELS = new Set(["error", "assert", "warn", "warning"]);
const ID_SEGMENT = /^\d+$|^[0-9a-f-]{8,}$/i;
const REPEAT_TEXT_MAX = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The route of a URL: the hash route for hash routers (`#/lobby`), else the path. */
export function routeLabelOf(url: string): string {
  const parsed = parseUrl(url);

  if (!parsed) {
    return url;
  }

  return parsed.hash.startsWith("#/")
    ? (parsed.hash.split("?")[0] ?? parsed.hash)
    : parsed.pathname;
}

/** Host and directory of a URL with id-like segments as `*` (`/a/7/b` → `host/a/*`). */
function directoryPattern(url: string): string {
  const parsed = parseUrl(url);
  const path = parsed ? parsed.pathname : (url.split(/[?#]/)[0] ?? "");
  const directory = path
    .split("/")
    .filter(Boolean)
    .slice(0, -1)
    .map((segment) => (ID_SEGMENT.test(segment) ? "*" : segment));
  return `${parsed?.host ?? ""}/${directory.join("/")}`;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\d+/g, "#").slice(0, REPEAT_TEXT_MAX);
}

function readMessageText(event: WebBlackboxEvent): string {
  const data = asRecord(event.data);
  return asText(data?.text) ?? asText(data?.message) ?? asText(data?.reason) ?? event.type;
}

function readNavigationUrl(event: WebBlackboxEvent): string {
  const data = asRecord(event.data);
  return asText(data?.url) ?? asText(asRecord(data?.frame)?.url) ?? "";
}

function readTargetKey(event: WebBlackboxEvent): string {
  const target = asRecord(asRecord(event.data)?.target);
  return asText(target?.selector) ?? asText(asRecord(target?.readable)?.css) ?? "";
}

type FeedContext = {
  input: ActivityFeedInput;
  scope: ActivityScope;
  triggerToAct: ReadonlyMap<string, string>;
  actIds: ReadonlySet<string>;
  /** Actions with span bounds, by start time. */
  spans: readonly Required<ActivityAction>[];
  requestById: ReadonlyMap<string, ActivityRequest>;
  /** The event that stands for each request (its `network.request`, else its first event). */
  requestByEventId: ReadonlyMap<string, ActivityRequest>;
};

function isThirdParty(url: string | null, context: FeedContext): boolean {
  return url !== null && isThirdPartyUrl(url, context.input.firstPartyUrl);
}

function requestTraits(request: ActivityRequest, context: FeedContext): ItemTraits | null {
  const isProblem = isProblemRequest(request);

  if (!isProblem && context.scope !== "all") {
    return null;
  }

  const outcome = request.status ?? request.errorText ?? "";
  return {
    kind: "request",
    reqId: request.reqId,
    isProblem,
    thirdParty: isThirdParty(request.url, context),
    repeatKey: `req:${request.method ?? ""}:${outcome}:${directoryPattern(request.url)}`
  };
}

function messageTraits(
  event: WebBlackboxEvent,
  kind: "console" | "exception",
  context: FeedContext
): ItemTraits {
  const url = readEventResourceUrl(event);
  const level = readConsoleLevel(event) ?? "";
  return {
    kind,
    isProblem: isProblemEvent(event),
    thirdParty: isThirdParty(url, context),
    repeatKey: `${kind}:${level}:${normalizeText(readMessageText(event))}:${url ? directoryPattern(url) : ""}`
  };
}

/** The row an event gets, or `null` when the feed leaves it out. */
function eventTraits(event: WebBlackboxEvent, context: FeedContext): ItemTraits | null {
  const type = event.type;
  const request = context.requestByEventId.get(event.id);

  if (request) {
    return requestTraits(request, context);
  }

  const linkedRequest =
    asText(asRecord(event.data)?.networkRequestId) ??
    (type.startsWith("network.") ? extractRequestId(event) : null);

  // A response, body or console line about a recorded request: the request row stands for it.
  if (linkedRequest && context.requestById.has(linkedRequest)) {
    return null;
  }

  if (type.startsWith("nav.")) {
    const url = readNavigationUrl(event);
    return {
      kind: "navigation",
      isProblem: false,
      thirdParty: false,
      repeatKey: `nav:${url}`,
      route: routeLabelOf(url)
    };
  }

  const isTrigger = context.triggerToAct.has(event.id);

  if (isTrigger || ACTION_TYPES.has(type)) {
    const collapsible = !isTrigger && COLLAPSIBLE_ACTION_TYPES.has(type);
    return {
      kind: "action",
      isProblem: false,
      thirdParty: false,
      repeatKey: collapsible ? `act:${type}:${readTargetKey(event)}` : `act:${event.id}`
    };
  }

  if (REALTIME_TYPES.has(type)) {
    const url = readEventResourceUrl(event) ?? "";
    return {
      kind: "realtime",
      isProblem: false,
      thirdParty: isThirdParty(url, context),
      repeatKey: `ws:${type}:${url.split("?")[0] ?? ""}`
    };
  }

  const level = readConsoleLevel(event);

  if (level !== null) {
    return context.scope === "all" || NOTICE_CONSOLE_LEVELS.has(level)
      ? messageTraits(event, "console", context)
      : null;
  }

  return type.startsWith("error.") || isProblemEvent(event)
    ? messageTraits(event, "exception", context)
    : null;
}

function buildContext(input: ActivityFeedInput, scope: ActivityScope): FeedContext {
  const typeById = new Map(input.events.map((event) => [event.id, event.type]));
  const requestByEventId = new Map<string, ActivityRequest>();

  for (const request of input.requests) {
    const eventId =
      request.eventIds.find((id) => typeById.get(id) === "network.request") ??
      request.eventIds.find((id) => typeById.has(id));

    if (eventId && !requestByEventId.has(eventId)) {
      requestByEventId.set(eventId, request);
    }
  }

  return {
    input,
    scope,
    triggerToAct: new Map(input.actions.map((action) => [action.triggerEventId, action.actId])),
    actIds: new Set(input.actions.map((action) => action.actId)),
    spans: input.actions
      .filter(
        (action): action is Required<ActivityAction> =>
          typeof action.startMono === "number" && typeof action.endMono === "number"
      )
      .sort((left, right) => left.startMono - right.startMono),
    requestById: new Map(input.requests.map((request) => [request.reqId, request])),
    requestByEventId
  };
}

/**
 * The action an event is a consequence of: its `ref.act` (for a request, the `ref.act` of any of
 * its events), else the latest action span whose bounds contain it. A trigger is not its own
 * consequence.
 */
function parentActionOf(
  event: WebBlackboxEvent,
  actId: string | null,
  context: FeedContext
): string | null {
  const linked = asText(event.ref?.act) ?? context.requestByEventId.get(event.id)?.actionId ?? null;

  if (linked && context.actIds.has(linked)) {
    return linked === actId ? null : linked;
  }

  for (let index = context.spans.length - 1; index >= 0; index -= 1) {
    const span = context.spans[index];

    if (!span || span.startMono > event.mono) {
      continue;
    }

    if (span.actId !== actId && event.mono <= span.endMono) {
      return span.actId;
    }
  }

  return null;
}

/**
 * The Activity feed's items in time order: user actions (every action span's trigger, plus
 * typing, submits and markers), navigations, failed requests (all requests for `scope: "all"`),
 * socket opens and closes, console warnings and errors, exceptions and the recording start.
 *
 * Each item knows the action it is a consequence of (the span's `ref.act`), whether it is a
 * problem (console errors by `data.level`) and whether it is third-party. Navigation items count
 * visits per route ("2nd"). Responses, bodies and console lines about a recorded request are left
 * out: the request row stands for them.
 */
export function selectActivityItems(
  input: ActivityFeedInput,
  scope: ActivityScope = "curated"
): ActivityItem[] {
  const context = buildContext(input, scope);
  const items: ActivityItem[] = [];
  const visits = new Map<string, number>();
  let started = false;

  for (const event of input.events) {
    const actId = context.triggerToAct.get(event.id) ?? null;
    const base = {
      eventId: event.id,
      mono: event.mono,
      actId,
      parentActId: parentActionOf(event, actId, context)
    };

    if (!started && event.type.startsWith("meta.")) {
      started = true;
      items.push({
        ...base,
        kind: "start",
        isProblem: false,
        thirdParty: false,
        repeatKey: "start"
      });
      continue;
    }

    const traits = eventTraits(event, context);

    if (!traits) {
      continue;
    }

    if (traits.route === undefined) {
      items.push({ ...base, ...traits });
      continue;
    }

    const visit = (visits.get(traits.route) ?? 0) + 1;
    visits.set(traits.route, visit);
    items.push({ ...base, ...traits, visit });
  }

  return items;
}

/** A feed row: one item, or several consecutive repeats ("×N"; the first item leads). */
export type ActivityRow = {
  items: ActivityItem[];
};

export type ActivityRowOptions = {
  errorsOnly?: boolean;
  hideThirdParty?: boolean;
  /** Text filter: items it rejects are left out. */
  matches?: (item: ActivityItem, index: number) => boolean;
  /** Items shown whatever the filters (the selection), not counted as hidden. */
  pinned?: (item: ActivityItem) => boolean;
};

export type ActivityRows = {
  rows: ActivityRow[];
  /** Items the other filters keep but "Hide third-party" hides (the "hidden N" chip). */
  hiddenThirdParty: number;
};

/**
 * Applies the feed filters and collapses consecutive repeats: items with the same `repeatKey`
 * and the same parent action that follow each other become one row. "Errors only" keeps the
 * problems and, for context, the actions they are consequences of.
 */
export function buildActivityRows(
  items: readonly ActivityItem[],
  options: ActivityRowOptions = {}
): ActivityRows {
  const isPinned = (item: ActivityItem): boolean => options.pinned?.(item) ?? false;
  const matching = options.matches
    ? items.filter((item, index) => isPinned(item) || (options.matches?.(item, index) ?? true))
    : items;
  const candidates = options.errorsOnly
    ? matching.filter((item) => isPinned(item) || item.isProblem || item.actId !== null)
    : matching;
  const visible = options.hideThirdParty
    ? candidates.filter((item) => isPinned(item) || !item.thirdParty)
    : candidates;
  const kept = options.errorsOnly ? keepActionsWithProblems(visible, isPinned) : visible;

  return {
    rows: collapseRepeats(kept),
    hiddenThirdParty: candidates.length - visible.length
  };
}

function keepActionsWithProblems(
  items: readonly ActivityItem[],
  isPinned: (item: ActivityItem) => boolean
): ActivityItem[] {
  const actsWithProblems = new Set(
    items.flatMap((item) => (item.isProblem && item.parentActId ? [item.parentActId] : []))
  );

  return items.filter(
    (item) =>
      item.isProblem || isPinned(item) || (item.actId !== null && actsWithProblems.has(item.actId))
  );
}

function collapseRepeats(items: readonly ActivityItem[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let current: ActivityItem[] | null = null;

  for (const item of items) {
    const head = current?.[0];

    if (
      current &&
      head &&
      head.repeatKey === item.repeatKey &&
      head.parentActId === item.parentActId
    ) {
      current.push(item);
      continue;
    }

    current = [item];
    rows.push({ items: current });
  }

  return rows;
}
