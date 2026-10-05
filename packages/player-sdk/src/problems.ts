import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { isThirdPartyUrl } from "./third-party.js";

/**
 * What kind of failure a problem is: an HTTP status class (`auth` = 401/403), a request that never
 * got a response (`network`), a thrown exception, or a console error that is neither.
 */
export type ProblemCategory = "auth" | "client" | "server" | "network" | "exception" | "console";

/** One occurrence of a problem: the event to select and, for requests, the request id. */
export type ProblemOccurrence = {
  eventId: string;
  mono: number;
  reqId?: string;
};

/** Failures of one kind grouped for the problems strip ("401 Unauthorized ×9 /gw/bff/*"). */
export type ProblemGroup = {
  key: string;
  category: ProblemCategory;
  /** HTTP status (`auth`, `client`, `server`). */
  status?: number;
  /** HTTP reason phrase: the recorded status text, or the standard phrase for the status. */
  reason?: string;
  /** Chromium net error without the `net::` prefix (`ERR_CONNECTION_RESET`), for `network`. */
  errorCode?: string;
  /** First line of the exception or console message (`exception`, `console`). */
  message?: string;
  /**
   * Where it happened: a URL path pattern (`/gw/bff/*`) for first-party HTTP errors, the host for
   * network errors and a single third-party host, the script location for messages; empty when
   * there is nothing short to say (several third-party hosts).
   */
  where: string;
  /** Distinct hosts of the requests or scripts involved, in first-seen order. */
  hosts: string[];
  /** Every occurrence belongs to a site other than the recorded one. */
  thirdParty: boolean;
  count: number;
  firstMono: number;
  lastMono: number;
  /** Sorted by time. */
  occurrences: ProblemOccurrence[];
};

/** The request fields problem grouping reads (a `NetworkWaterfallEntry` fits). */
export type ProblemRequest = {
  reqId: string;
  url: string;
  status?: number;
  statusText?: string;
  failed: boolean;
  errorText?: string;
  startMono: number;
  eventIds: string[];
};

export type ProblemGroupingInput = {
  events: readonly WebBlackboxEvent[];
  requests: readonly ProblemRequest[];
  /** The recorded page (`manifest.site.origin`): decides what is third-party. */
  firstPartyUrl: string;
};

const MESSAGE_MAX = 160;
const PROBLEM_CONSOLE_LEVELS = new Set(["error", "assert"]);
/** A cancelled request (navigation away, aborted fetch, prefetch) is not a failure. */
const CANCELLED_ERROR = /ERR_ABORTED/i;

const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout"
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
    return new URL(url).pathname || "/";
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

/** Console level of a `console.*` event: `data.level`, then `event.lvl`, lower-cased. */
export function readConsoleLevel(event: WebBlackboxEvent): string | null {
  if (!event.type.startsWith("console.")) {
    return null;
  }

  const level = asText(asRecord(event.data)?.level) ?? asText(event.lvl);
  return level ? level.toLowerCase() : null;
}

/**
 * Whether an event is an error by itself (PROPOSAL §2.3): `error.*` events, events at the
 * `error` level, and console entries whose `data.level` is `error` or `assert` (the recorder keeps
 * the console level there, not in `lvl`). Failed requests are judged by `isProblemRequest`.
 */
export function isProblemEvent(event: WebBlackboxEvent): boolean {
  if (event.type.startsWith("error.") || event.lvl === "error") {
    return true;
  }

  const level = readConsoleLevel(event);
  return level !== null && PROBLEM_CONSOLE_LEVELS.has(level);
}

/** A request that failed: an HTTP status of 400 or more, or a network error other than a cancel. */
export function isProblemRequest(request: ProblemRequest): boolean {
  if (typeof request.status === "number" && request.status >= 400) {
    return true;
  }

  return request.failed && !CANCELLED_ERROR.test(request.errorText ?? "");
}

/**
 * The URL an event is about: the request or WebSocket URL, or the script that logged or threw
 * (for third-party marking). `null` when the event names none.
 */
export function readEventResourceUrl(event: WebBlackboxEvent): string | null {
  const data = asRecord(event.data);

  return (
    asText(data?.url) ??
    asText(asRecord(data?.request)?.url) ??
    asText(data?.filename) ??
    asText(data?.sourceUrl) ??
    null
  );
}

function readMessage(event: WebBlackboxEvent): string {
  const data = asRecord(event.data);
  const text =
    asText(data?.message) ??
    asText(data?.text) ??
    asText(data?.reason) ??
    asText(asRecord(data?.error)?.message) ??
    event.type;
  const firstLine = text.split("\n")[0]?.trim() || text;
  return firstLine.length > MESSAGE_MAX ? `${firstLine.slice(0, MESSAGE_MAX - 1)}…` : firstLine;
}

/** Messages differing only in numbers, ids or quoted values belong to one group. */
function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/(["'`]).*?\1/g, "?")
    .replace(/\b[0-9a-f]{8,}\b/g, "#")
    .replace(/\d+/g, "#");
}

const STACK_URL = /((?:https?|chrome-extension|moz-extension):\/\/[^\s()]+)/;

/**
 * `file.js:57` for a message: the script of its top stack frame (`stackTop`, else the first URL in
 * `stack` or in the message itself), else the event URL; the column is dropped.
 */
function readLocation(event: WebBlackboxEvent): string {
  const data = asRecord(event.data);
  const stackText =
    asText(data?.stackTop) ?? asText(data?.stack) ?? asText(data?.message) ?? asText(data?.text);
  const source = (stackText ? STACK_URL.exec(stackText)?.[1] : null) ?? readEventResourceUrl(event);

  if (!source) {
    return "";
  }

  const file = pathOf(source).split("/").filter(Boolean).pop() ?? hostOf(source);
  return file.replace(/(:\d+):\d+$/, "$1");
}

function firstSegment(path: string): string {
  return path.split("/").filter(Boolean)[0] ?? "";
}

/** The path itself when all are equal, else the shared leading segments plus `/*`. */
function pathPattern(paths: readonly string[]): string {
  const unique = [...new Set(paths)];

  if (unique.length <= 1) {
    return unique[0] ?? "";
  }

  const split = unique.map((path) => path.split("/").filter(Boolean));
  const shared: string[] = [];

  for (let index = 0; index < (split[0]?.length ?? 0); index += 1) {
    const segment = split[0]?.[index];

    if (segment === undefined || !split.every((parts) => parts[index] === segment)) {
      break;
    }

    shared.push(segment);
  }

  return shared.length > 0 ? `/${shared.join("/")}/*` : "/*";
}

function categoryOfStatus(status: number): ProblemCategory {
  if (status === 401 || status === 403) {
    return "auth";
  }

  return status >= 500 ? "server" : "client";
}

/** The event that stands for a request: its `network.request` event, else its first event. */
function requestEventId(
  request: ProblemRequest,
  byId: ReadonlyMap<string, WebBlackboxEvent>
): string | undefined {
  return (
    request.eventIds.find((id) => byId.get(id)?.type === "network.request") ?? request.eventIds[0]
  );
}

type GroupSeed = Pick<ProblemGroup, "category" | "status" | "reason" | "errorCode" | "message">;

type Draft = GroupSeed & {
  key: string;
  occurrences: ProblemOccurrence[];
  hosts: string[];
  /** URL paths of requests, or script locations of messages. */
  places: string[];
  thirdPartyFlags: boolean[];
};

type Occurrence = {
  key: string;
  seed: GroupSeed;
  occurrence: ProblemOccurrence;
  url: string | null;
  place: string;
  thirdParty: boolean;
};

type FailedResource = {
  url: string;
  mono: number;
  eventId: string;
  reqId?: string;
  status?: number;
  statusText?: string;
  errorText?: string;
};

function resourceOccurrence(resource: FailedResource, firstPartyUrl: string): Occurrence {
  const thirdParty = isThirdPartyUrl(resource.url, firstPartyUrl);
  const occurrence: ProblemOccurrence = { eventId: resource.eventId, mono: resource.mono };
  const path = pathOf(resource.url);
  const base = { occurrence, url: resource.url, place: path, thirdParty };

  if (resource.reqId) {
    occurrence.reqId = resource.reqId;
  }

  if (typeof resource.status === "number" && resource.status >= 400) {
    const status = resource.status;
    const scope = thirdParty ? "third" : `${hostOf(resource.url)}/${firstSegment(path)}`;
    return {
      ...base,
      key: `http:${status}:${scope}`,
      seed: {
        category: categoryOfStatus(status),
        status,
        reason: resource.statusText?.trim() || REASON_PHRASES[status]
      }
    };
  }

  const errorCode = (resource.errorText ?? "failed").replace(/^net::/, "");
  return {
    ...base,
    key: `net:${errorCode}:${thirdParty ? "third" : hostOf(resource.url)}`,
    seed: { category: "network", errorCode }
  };
}

const FAILED_RESOURCE_TEXT = /^Failed to load resource:/i;
const STATUS_IN_TEXT = /status of (\d{3})/;
const NET_ERROR_IN_TEXT = /net::(ERR_[A-Z0-9_]+)/;

/**
 * Chromium logs "Failed to load resource: …" for every failed load, including loads from before
 * the recording started (their request is not in the archive). Such an entry is the same kind of
 * problem as the request: its status or net error, at its URL.
 */
function readFailedResource(event: WebBlackboxEvent): FailedResource | null {
  const data = asRecord(event.data);
  const text = asText(data?.text) ?? asText(data?.message) ?? "";
  const url = asText(data?.url);

  if (!url || !FAILED_RESOURCE_TEXT.test(text)) {
    return null;
  }

  const status = Number(STATUS_IN_TEXT.exec(text)?.[1]);
  const errorText = NET_ERROR_IN_TEXT.exec(text)?.[1];
  return {
    url,
    mono: event.mono,
    eventId: event.id,
    ...(Number.isFinite(status) ? { status } : {}),
    ...(errorText ? { errorText } : {})
  };
}

function eventOccurrence(event: WebBlackboxEvent, firstPartyUrl: string): Occurrence {
  const message = readMessage(event);
  const category: ProblemCategory = event.type.startsWith("console.") ? "console" : "exception";
  const url = readEventResourceUrl(event);

  return {
    // A logged error and the exception it describes ("AuthError: …") are one problem.
    key: `message:${normalizeMessage(message)}`,
    seed: { category, message },
    occurrence: { eventId: event.id, mono: event.mono },
    url,
    place: readLocation(event),
    thirdParty: url !== null && isThirdPartyUrl(url, firstPartyUrl)
  };
}

function collectOccurrences(input: ProblemGroupingInput): Occurrence[] {
  const byId = new Map(input.events.map((event) => [event.id, event]));
  const knownRequests = new Set(input.requests.map((request) => request.reqId));
  const occurrences: Occurrence[] = [];

  for (const request of input.requests) {
    const eventId = requestEventId(request, byId);

    if (eventId && isProblemRequest(request)) {
      occurrences.push(
        resourceOccurrence(
          {
            url: request.url,
            mono: request.startMono,
            eventId,
            reqId: request.reqId,
            status: request.status,
            statusText: request.statusText,
            errorText: request.errorText
          },
          input.firstPartyUrl
        )
      );
    }
  }

  for (const event of input.events) {
    const linkedRequest = asText(asRecord(event.data)?.networkRequestId);

    if (!isProblemEvent(event) || (linkedRequest && knownRequests.has(linkedRequest))) {
      // A console line about a recorded request: the request is already the problem.
      continue;
    }

    const resource = readFailedResource(event);
    occurrences.push(
      resource
        ? resourceOccurrence(resource, input.firstPartyUrl)
        : eventOccurrence(event, input.firstPartyUrl)
    );
  }

  return occurrences;
}

/**
 * Groups the session's failures for the problems strip:
 * - failed requests by HTTP status (first-party: per host and first path segment; third-party:
 *   one group per status) or by net error (per host; third-party: one group per error);
 * - exceptions and console errors by message (a logged error and the exception it describes are
 *   one group), ignoring numbers, ids and quoted values.
 *
 * A console "Failed to load resource" entry that points at a recorded request
 * (`data.networkRequestId`) belongs to that request; cancelled requests (`ERR_ABORTED`) are not
 * problems. Sorted first-party first, then by count (descending), then by first occurrence.
 */
export function groupProblems(input: ProblemGroupingInput): ProblemGroup[] {
  const drafts = new Map<string, Draft>();

  for (const { key, seed, occurrence, url, place, thirdParty } of collectOccurrences(input)) {
    const draft = drafts.get(key) ?? {
      key,
      ...seed,
      occurrences: [],
      hosts: [],
      places: [],
      thirdPartyFlags: []
    };
    const host = url ? hostOf(url) : "";

    if (host && !draft.hosts.includes(host)) {
      draft.hosts.push(host);
    }

    if (place) {
      draft.places.push(place);
    }

    draft.occurrences.push(occurrence);
    draft.thirdPartyFlags.push(thirdParty);
    // Thrown beats logged: a group with an exception is an exception.
    drafts.set(key, seed.category === "exception" ? { ...draft, category: "exception" } : draft);
  }

  return [...drafts.values()].map(finishGroup).sort(compareGroups);
}

function describeWhere(draft: Draft, thirdParty: boolean): string {
  switch (draft.category) {
    case "exception":
    case "console":
      return draft.places[0] ?? "";
    case "network":
      return thirdParty && draft.hosts.length > 1 ? "" : (draft.hosts[0] ?? "");
    default:
      if (thirdParty) {
        return draft.hosts.length === 1 ? (draft.hosts[0] ?? "") : "";
      }

      return pathPattern(draft.places);
  }
}

function finishGroup(draft: Draft): ProblemGroup {
  const occurrences = [...draft.occurrences].sort((left, right) => left.mono - right.mono);
  const thirdParty = draft.thirdPartyFlags.every(Boolean);

  return {
    key: draft.key,
    category: draft.category,
    ...(draft.status !== undefined ? { status: draft.status } : {}),
    ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
    ...(draft.errorCode !== undefined ? { errorCode: draft.errorCode } : {}),
    ...(draft.message !== undefined ? { message: draft.message } : {}),
    hosts: draft.hosts,
    where: describeWhere(draft, thirdParty),
    thirdParty,
    count: occurrences.length,
    firstMono: occurrences[0]?.mono ?? 0,
    lastMono: occurrences[occurrences.length - 1]?.mono ?? 0,
    occurrences
  };
}

function compareGroups(left: ProblemGroup, right: ProblemGroup): number {
  if (left.thirdParty !== right.thirdParty) {
    return left.thirdParty ? 1 : -1;
  }

  return right.count - left.count || left.firstMono - right.firstMono;
}

/** Every occurrence of every group in time order (E / Shift+E, the Errors lane). */
export function listProblemOccurrences(groups: readonly ProblemGroup[]): ProblemOccurrence[] {
  return groups.flatMap((group) => group.occurrences).sort((left, right) => left.mono - right.mono);
}
