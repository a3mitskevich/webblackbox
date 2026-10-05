import uFuzzy from "@leeoniya/ufuzzy";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import {
  buildActivityRows,
  buildRouteChapters,
  readEventResourceUrl,
  selectActivityItems,
  type ActionTimelineEntry,
  type ActivityItem,
  type ActivityRow,
  type ProblemGroup,
  type RouteChapterKind
} from "@webblackbox/player-sdk";

import type { PlayerLocale } from "../../../lib/i18n.js";
import { asFiniteNumber, asRecord, asString } from "../../../lib/parsing.js";
import { compactText, shortUrl } from "../../../lib/text.js";
import type { IconName } from "../../components/icon.js";
import { resolveSelectedEventId, type ListStepItem } from "../../controller.js";
import type { LoadedArchive, PlayerState } from "../../state.js";
import { feedMessages, type FeedKey, type FeedTranslator } from "./messages.js";
import { formatOrdinal, problemPhrase } from "./problem-text.js";
import { feedSlice } from "./slice.js";

/** Colour family of a row (PROPOSAL §8 semantics). */
export type FeedTone = "plain" | "action" | "navigation" | "error" | "warn" | "realtime";

/** What a feed row says. Archive text (URLs, messages, selectors) is never translated. */
export type FeedRowText = {
  tone: FeedTone;
  glyph: IconName;
  /** HTTP status, shown as a coloured code before the line. */
  code: string | null;
  /** "Click", "Route", "GET", "WebSocket opened" … */
  lead: string;
  /** The object of the line: the target, the route (monospace), the path, the message. */
  subject: string;
  subjectIsCode: boolean;
  secondary: string;
  /** "2nd" visit of a route. */
  badge: string | null;
  /** "First auth failure after this click". */
  flag: string | null;
};

/** One rendered line of the feed: a row's first item, or an item of an expanded repeat group. */
export type FeedEntry = {
  key: string;
  item: ActivityItem;
  /** Items the row stands for (1 unless it is the head of a "×N" group). */
  count: number;
  /** A head whose repeats are listed under it. */
  expanded: boolean;
  /** An item listed under its group's head. */
  nested: boolean;
};

export type FeedView = {
  entries: FeedEntry[];
  hiddenThirdParty: number;
  /** A text filter is applied (the feed then also lists successful requests and console logs). */
  searching: boolean;
};

export type FeedParams = {
  query: string;
  errorsOnly: boolean;
  hideThirdParty: boolean;
  expanded: readonly string[];
  selectedEventId: string | null;
  locale: PlayerLocale;
};

type StreamStats = { frames: number; signalR: boolean };

type ProblemFlag = { group: ProblemGroup; afterAction: boolean };

/** Everything the feed derives once per opened archive. */
type FeedData = {
  curated: ActivityItem[];
  all: () => ActivityItem[];
  actionById: ReadonlyMap<string, ActionTimelineEntry>;
  streams: ReadonlyMap<string, StreamStats>;
  navigationKinds: ReadonlyMap<string, RouteChapterKind>;
  /** Flagged rows: the first problem after each action, the first of each first-party group. */
  flags: ReadonlyMap<string, ProblemFlag>;
};

export type DescribeContext = {
  archive: LoadedArchive;
  data: FeedData;
  t: FeedTranslator;
  locale: PlayerLocale;
};

const PRIMARY_MAX = 160;
const SECONDARY_MAX = 140;
const SIGNALR_SEPARATOR = "\u001e";
const ACTION_VERBS: Readonly<Record<string, FeedKey>> = {
  "user.click": "actClick",
  "user.dblclick": "actDblclick",
  "user.contextmenu": "actContextmenu",
  "user.auxclick": "actAuxclick",
  "user.input": "actInput",
  "user.keydown": "actKeydown",
  "user.submit": "actSubmit",
  "user.marker": "actMarker",
  "user.drag.start": "actDrag"
};

const dataCache = new WeakMap<LoadedArchive, FeedData>();

function streamStatsOf(archive: LoadedArchive): Map<string, StreamStats> {
  const streams = new Map<string, StreamStats>();

  for (const entry of archive.model.realtime) {
    if (entry.eventType !== "network.ws.frame" || !entry.streamId) {
      continue;
    }

    const stats = streams.get(entry.streamId) ?? { frames: 0, signalR: false };
    streams.set(entry.streamId, {
      frames: stats.frames + 1,
      signalR: stats.signalR || (entry.payloadPreview?.includes(SIGNALR_SEPARATOR) ?? false)
    });
  }

  return streams;
}

function buildFeedData(archive: LoadedArchive): FeedData {
  const { model, view } = archive;
  const input = {
    events: model.events,
    actions: model.actionTimeline,
    requests: model.waterfall,
    firstPartyUrl: view.meta.origin
  };
  const chapters = buildRouteChapters(model.events, {
    endMono: model.maxMono,
    initialUrl: view.meta.origin
  });
  const curated = selectActivityItems(input);
  let all: ActivityItem[] | null = null;

  return {
    curated,
    all: () => (all ??= selectActivityItems(input, "all")),
    actionById: new Map(model.actionTimeline.map((action) => [action.actId, action])),
    streams: streamStatsOf(archive),
    navigationKinds: new Map(
      chapters.flatMap((chapter) => (chapter.eventId ? [[chapter.eventId, chapter.kind]] : []))
    ),
    flags: problemFlags(curated, view.problems)
  };
}

/**
 * "First auth failure after this click": the first first-party problem among each action's
 * consequences, and the first occurrence of each first-party problem group outside any action.
 */
function problemFlags(
  items: readonly ActivityItem[],
  problems: readonly ProblemGroup[]
): Map<string, ProblemFlag> {
  const groupByEvent = new Map<string, ProblemGroup>();

  for (const group of problems) {
    if (!group.thirdParty) {
      group.occurrences.forEach((occurrence) => groupByEvent.set(occurrence.eventId, group));
    }
  }

  const flags = new Map<string, ProblemFlag>();
  const flaggedActions = new Set<string>();
  const seenGroups = new Set<string>();

  for (const item of items) {
    const group = groupByEvent.get(item.eventId);

    if (!group) {
      continue;
    }

    if (item.parentActId && !flaggedActions.has(item.parentActId)) {
      flaggedActions.add(item.parentActId);
      flags.set(item.eventId, { group, afterAction: true });
    } else if (!item.parentActId && !seenGroups.has(group.key)) {
      flags.set(item.eventId, { group, afterAction: false });
    }

    seenGroups.add(group.key);
  }

  return flags;
}

export function feedDataOf(archive: LoadedArchive): FeedData {
  const cached = dataCache.get(archive);

  if (cached) {
    return cached;
  }

  const data = buildFeedData(archive);
  dataCache.set(archive, data);
  return data;
}

function readTarget(event: WebBlackboxEvent | undefined): { text: string; css: string } {
  const target = asRecord(asRecord(event?.data)?.target);
  const readable = asRecord(target?.readable);

  return {
    text: asString(readable?.text) ?? asString(target?.text) ?? "",
    css: asString(readable?.css) ?? asString(target?.selector) ?? asString(target?.tag) ?? ""
  };
}

function actionSummary(actId: string | null, data: FeedData, t: FeedTranslator): string {
  const action = actId ? data.actionById.get(actId) : undefined;

  if (!action || action.requestCount === 0) {
    return "";
  }

  const failed = action.requests.filter(
    (request) => request.failed || (request.status ?? 0) >= 400
  ).length;
  const requests = t("requestsN", { count: action.requestCount });
  return failed > 0 ? `${requests} · ${t("failedN", { count: failed })}` : requests;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

type Described = Omit<FeedRowText, "flag" | "badge" | "tone" | "secondary"> & {
  tone?: FeedTone;
  secondary: string[];
};

function line(
  lead: string,
  subject: string,
  secondary: string[] = [],
  extra: Partial<Described> = {}
): Described {
  return {
    glyph: "flag",
    code: null,
    lead,
    subject: compactText(subject, PRIMARY_MAX),
    subjectIsCode: false,
    secondary,
    ...extra
  };
}

function describeStart({ archive, t }: DescribeContext): Described {
  const { meta } = archive.view;
  const mode = meta.mode ? `${meta.mode.charAt(0).toUpperCase()}${meta.mode.slice(1)}` : "";
  const media = meta.hasVideo
    ? t("tabVideo")
    : meta.screenshotCount > 0
      ? t("screenshotsN", { count: meta.screenshotCount })
      : "";

  return line(t("recordingStarted"), "", [
    mode ? t("captureMode", { mode }) : "",
    media,
    meta.otherTabs > 0 ? t("otherTabsOpen", { count: meta.otherTabs }) : ""
  ]);
}

function describeAction(
  item: ActivityItem,
  event: WebBlackboxEvent | undefined,
  { t, data }: DescribeContext
): Described {
  const type = event?.type ?? "";

  if (type === "user.visibility") {
    const hidden = asString(asRecord(event?.data)?.state) === "hidden";
    return line(t(hidden ? "tabHidden" : "tabShown"), "", [], { glyph: "tabs" });
  }

  const target = readTarget(event);
  const key = type === "user.keydown" ? (asString(asRecord(event?.data)?.key) ?? "") : "";
  const subject = key || (target.text ? `“${target.text}”` : target.css);

  return line(
    t(ACTION_VERBS[type] ?? "actAction"),
    subject,
    [target.text && !key ? target.css : "", actionSummary(item.actId, data, t)],
    { glyph: "click", tone: "action" }
  );
}

function describeNavigation(
  item: ActivityItem,
  event: WebBlackboxEvent | undefined,
  { t, data }: DescribeContext
): Described {
  const payload = asRecord(event?.data);
  const url = asString(payload?.url) ?? asString(asRecord(payload?.frame)?.url) ?? "";
  const summary = actionSummary(item.actId, data, t);

  if (event?.type === "nav.commit" || event?.type === "nav.reload") {
    const reload =
      event.type === "nav.reload" || data.navigationKinds.get(item.eventId) === "reload";
    return line(t(reload ? "pageReload" : "pageLoad"), shortUrl(url), [summary], {
      glyph: "nav",
      tone: "navigation"
    });
  }

  return line(t("route"), item.route ?? shortUrl(url), [summary], {
    glyph: "nav",
    tone: "navigation",
    subjectIsCode: true
  });
}

function describeRequest(item: ActivityItem, { archive, t }: DescribeContext): Described {
  const entry = item.reqId ? archive.model.waterfallByReqId.get(item.reqId) : undefined;

  if (!entry) {
    return line(t("failed"), item.reqId ?? "", [], { glyph: "req" });
  }

  const host = hostOf(entry.url);
  const outcome = entry.failed && entry.errorText ? entry.errorText : (entry.mimeType ?? "");

  return line(
    entry.method.toUpperCase(),
    shortUrl(entry.url),
    [
      `${Math.round(entry.durationMs)} ms`,
      outcome,
      host !== hostOf(archive.view.meta.origin) ? host : ""
    ],
    {
      glyph: item.isProblem ? "error" : "req",
      code: typeof entry.status === "number" ? String(entry.status) : null
    }
  );
}

function describeRealtime(
  event: WebBlackboxEvent | undefined,
  { t, data }: DescribeContext
): Described {
  const url = event ? (readEventResourceUrl(event) ?? "") : "";
  const stats = data.streams.get(asString(asRecord(event?.data)?.requestId) ?? "");
  const opened = event?.type === "network.ws.open";

  return line(
    t(opened ? "wsOpened" : "wsClosed"),
    pathOf(url),
    [
      opened && stats ? t("framesN", { count: stats.frames }) : "",
      opened && stats?.signalR ? "SignalR" : ""
    ],
    { glyph: "ws", tone: "realtime" }
  );
}

/** `main.js:57` from a stack top (`fn (https://…/main.js:1:20412)`) or the file and line. */
function readLocation(event: WebBlackboxEvent | undefined): string {
  const data = asRecord(event?.data);
  const stackTop = asString(data?.stackTop);

  if (stackTop) {
    const source = stackTop.replace(/^.*?[@(]\s*/, "").replace(/\)$/, "");
    return pathOf(source).split("/").pop() ?? source;
  }

  const file = asString(data?.filename) ?? asString(data?.url) ?? "";
  const lineNumber = asFiniteNumber(data?.lineno);
  const name = pathOf(file).split("/").pop() ?? "";
  return name && lineNumber ? `${name}:${lineNumber}` : name;
}

function describeMessage(item: ActivityItem, event: WebBlackboxEvent | undefined): Described {
  const data = asRecord(event?.data);
  const message =
    asString(data?.text) ?? asString(data?.message) ?? asString(data?.reason) ?? event?.type ?? "";
  const level = item.kind === "console" && !item.isProblem ? (asString(data?.level) ?? "") : "";

  return line("", message.split("\n")[0] ?? message, [level, readLocation(event)], {
    glyph: item.kind === "console" ? "console" : "error",
    tone: item.isProblem ? "error" : "warn"
  });
}

function describeBody(item: ActivityItem, context: DescribeContext): Described {
  const event = context.archive.model.eventById.get(item.eventId);

  switch (item.kind) {
    case "start":
      return describeStart(context);
    case "action":
      return describeAction(item, event, context);
    case "navigation":
      return describeNavigation(item, event, context);
    case "request":
      return describeRequest(item, context);
    case "realtime":
      return describeRealtime(event, context);
    default:
      return describeMessage(item, event);
  }
}

function describeFlag(item: ActivityItem, { data, t }: DescribeContext): string | null {
  const flag = data.flags.get(item.eventId);

  if (!flag) {
    return null;
  }

  const problem = problemPhrase(flag.group, t);
  const parent = item.parentActId ? data.actionById.get(item.parentActId) : undefined;

  if (!flag.afterAction || !parent) {
    return t("flagFirst", { problem });
  }

  const afterClick = /click/.test(parent.triggerType ?? "");
  return t(afterClick ? "flagFirstAfterClick" : "flagFirstAfterAction", { problem });
}

/** The text of one feed row (archive text as recorded, labels in the locale). */
export function describeFeedItem(item: ActivityItem, context: DescribeContext): FeedRowText {
  const body = describeBody(item, context);
  const isRequestLike = item.kind !== "console" && item.kind !== "exception";
  const secondary = [...body.secondary, item.thirdParty ? context.t("thirdParty") : ""];

  return {
    ...body,
    tone: item.isProblem && isRequestLike ? "error" : (body.tone ?? "plain"),
    secondary: compactText(secondary.filter(Boolean).join(" · "), SECONDARY_MAX),
    badge:
      item.visit !== undefined && item.visit > 1 ? formatOrdinal(item.visit, context.locale) : null,
    flag: describeFlag(item, context)
  };
}

export function describeContext(archive: LoadedArchive, locale: PlayerLocale): DescribeContext {
  return {
    archive,
    data: feedDataOf(archive),
    t: (key, values) => feedMessages.translate(locale, key, values),
    locale
  };
}

/** Unicode-aware (Cyrillic, CJK) uFuzzy: a word's parts in order, no typos. */
const fuzzy = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d']+",
  intraSplit: "\\p{Ll}\\p{Lu}",
  intraBound: "\\p{Ll}\\p{Lu}",
  intraChars: "[\\p{L}\\d']",
  intraContr: "'\\p{L}{1,2}\\b"
});

const haystackCache = new WeakMap<readonly ActivityItem[], Map<PlayerLocale, string[]>>();

/** The searchable text of each item: what the row shows, the event type and the full URL. */
function haystackOf(items: readonly ActivityItem[], context: DescribeContext): string[] {
  const byLocale = haystackCache.get(items) ?? new Map<PlayerLocale, string[]>();
  const cached = byLocale.get(context.locale);

  if (cached) {
    return cached;
  }

  const { model } = context.archive;
  const haystack = items.map((item) => {
    const row = describeFeedItem(item, context);
    const event = model.eventById.get(item.eventId);
    const url =
      (item.reqId ? model.waterfallByReqId.get(item.reqId)?.url : null) ??
      (event ? readEventResourceUrl(event) : null) ??
      "";
    return [row.code, row.lead, row.subject, row.secondary, event?.type, url].join(" ");
  });

  byLocale.set(context.locale, haystack);
  haystackCache.set(items, byLocale);
  return haystack;
}

/**
 * Indexes of the items matching the query: every whitespace-separated word must match, in any
 * order; within a word uFuzzy matches its parts in order (`casino-user` → "casino … user").
 */
export function matchFeedItems(haystack: readonly string[], query: string): Set<number> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  let matches: number[] | undefined;

  for (const word of words) {
    matches = fuzzy.filter(haystack as string[], word, matches) ?? [];

    if (matches.length === 0) {
      break;
    }
  }

  return new Set(matches ?? []);
}

/**
 * The Activity tab count: every event of the recording ("Activity 1 896" in the mockup), or the
 * items matching the text filter while one is typed (labels matched in English).
 */
export function countActivity(archive: LoadedArchive, query: string): number {
  if (!query.trim()) {
    return archive.model.events.length;
  }

  const items = feedDataOf(archive).all();
  return matchFeedItems(haystackOf(items, describeContext(archive, "en")), query).size;
}

function toEntries(rows: readonly ActivityRow[], params: FeedParams): FeedEntry[] {
  return rows.flatMap((row): FeedEntry[] => {
    const [head, ...rest] = row.items;

    if (!head) {
      return [];
    }

    const expanded =
      rest.length > 0 &&
      (params.expanded.includes(head.eventId) ||
        rest.some((item) => item.eventId === params.selectedEventId));
    const headEntry: FeedEntry = {
      key: head.eventId,
      item: head,
      count: row.items.length,
      expanded,
      nested: false
    };
    const nested = rest.map(
      (item): FeedEntry => ({ key: item.eventId, item, count: 1, expanded: false, nested: true })
    );

    return expanded ? [headEntry, ...nested] : [headEntry];
  });
}

/**
 * The feed for an archive and its filters: the rows (repeat groups open when expanded or when
 * they hold the selection), and how many third-party rows "Hide third-party" hides. The selected
 * event is always listed, whatever the filters.
 */
export function computeFeedView(archive: LoadedArchive, params: FeedParams): FeedView {
  const data = feedDataOf(archive);
  const searching = params.query.trim().length > 0;
  const items = searching ? data.all() : data.curated;
  const matches = searching
    ? matchFeedItems(haystackOf(items, describeContext(archive, params.locale)), params.query)
    : null;
  const { rows, hiddenThirdParty } = buildActivityRows(items, {
    errorsOnly: params.errorsOnly,
    hideThirdParty: params.hideThirdParty,
    ...(matches ? { matches: (_item: ActivityItem, index: number) => matches.has(index) } : {}),
    pinned: (item) => item.eventId === params.selectedEventId
  });

  return { entries: toEntries(rows, params), hiddenThirdParty, searching };
}

export function feedParamsOf(state: PlayerState): FeedParams {
  const slice = feedSlice.select(state);

  return {
    query: state.query,
    errorsOnly: slice.errorsOnly,
    hideThirdParty: slice.hideThirdParty,
    expanded: slice.expanded,
    selectedEventId: state.archive ? resolveSelectedEventId(state.archive, state.selection) : null,
    locale: state.locale
  };
}

function sameParams(left: FeedParams, right: FeedParams): boolean {
  return (
    left.query === right.query &&
    left.errorsOnly === right.errorsOnly &&
    left.hideThirdParty === right.hideThirdParty &&
    left.expanded === right.expanded &&
    left.selectedEventId === right.selectedEventId &&
    left.locale === right.locale
  );
}

let lastView: { archive: LoadedArchive; params: FeedParams; view: FeedView } | null = null;

/** `computeFeedView`, memoized for the last archive and filters (the list and J / L share it). */
export function feedViewOf(archive: LoadedArchive, params: FeedParams): FeedView {
  if (lastView && lastView.archive === archive && sameParams(lastView.params, params)) {
    return lastView.view;
  }

  const view = computeFeedView(archive, params);
  lastView = { archive, params, view };
  return view;
}

/** J / L in the Activity tab: the listed rows (and opened repeats) in order. */
export function feedStepItems(archive: LoadedArchive, state: PlayerState): ListStepItem[] {
  return feedViewOf(archive, feedParamsOf(state)).entries.map((entry) => ({
    selection: { kind: "event", id: entry.item.eventId },
    mono: entry.item.mono
  }));
}
