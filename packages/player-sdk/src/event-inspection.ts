import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { routeLabelOf } from "./activity-feed.js";
import { isMaskedValue, readReadableSelector } from "./pointer-insights.js";
import { isProblemEvent, isProblemRequest, readConsoleLevel } from "./problems.js";

/**
 * What the event inspector shows about one event (PROPOSAL §9 B "Event inspector"): the target of
 * a user action, what the action caused, and a structured one-line phrase the Player words in the
 * reader's language (casefile C's "The user clicked … in the lobby.").
 */

export type InspectedRect = { x: number; y: number; width: number; height: number };

export type PointerButtonName = "left" | "middle" | "right" | "back" | "forward";

export type InspectedTarget = {
  /** The readable CSS selector recorded for the target; never a hashed one. */
  selector: string | null;
  /** The profile kept only a hashed selector (the target cannot be matched by a test). */
  selectorMasked: boolean;
  /** Visible text or accessible name. */
  text: string | null;
  role: string | null;
  testId: string | null;
  href: string | null;
  /** `<button class="btn primary">`, built from the recorded tag, id and classes. */
  element: string | null;
  /** `getBoundingClientRect()` in the frame's CSS pixels. */
  rect: InspectedRect | null;
  viewport: { width: number; height: number } | null;
  /** Offset of the frame in the top viewport (iframe targets), when the capture could read it. */
  frameOffset: { x: number; y: number } | null;
  pointer: { x: number; y: number; button: PointerButtonName | null; modifiers: string[] } | null;
};

export type ClickReaction = {
  /** The DOM changed within the probe window. */
  mutated: boolean;
  /** Time from the click to the first DOM change. */
  latencyMs: number | null;
  windowMs: number | null;
};

export type ConsequenceKind =
  | "request"
  | "page-load"
  | "route"
  | "websocket"
  | "console-error"
  | "exception";

export type ActionConsequence = {
  kind: ConsequenceKind;
  eventId: string;
  mono: number;
  /** Time since the action started. */
  offsetMs: number;
  /** Request URL, route, socket URL or message. */
  label: string;
  method: string | null;
  status: number | null;
  failed: boolean;
  reqId: string | null;
  /** Repeats folded into this item (same failure on the same endpoint pattern). */
  count: number;
};

export type ActionConsequenceRequest = {
  reqId: string;
  method?: string;
  url: string;
  status?: number | null;
  failed: boolean;
  errorText?: string;
  startMono: number;
  eventIds?: string[];
};

export type ActionConsequenceInput = {
  startMono: number;
  endMono: number;
  /** Events of the action span (its trigger and everything with `ref.act`), any order. */
  events: readonly WebBlackboxEvent[];
  /** The event that started the action: never listed as its own consequence. */
  triggerEventId?: string;
  /** Requests made during the action. */
  requests: readonly ActionConsequenceRequest[];
  /** Notable items to keep (default 8). */
  maxItems?: number;
};

export type ActionConsequences = {
  durationMs: number;
  requests: number;
  failedRequests: number;
  consoleErrors: number;
  exceptions: number;
  webSockets: number;
  navigations: number;
  /** Notable items in time order: failures, page loads, route changes, sockets, errors. */
  items: ActionConsequence[];
  /** Notable items left out by `maxItems`. */
  hiddenItems: number;
  /** The first failed request or error (the "failing moment" of the action). */
  firstFailure: ActionConsequence | null;
  /** The first failed request, even when an error came before it (or `maxItems` hid it). */
  firstFailedRequest: ActionConsequence | null;
};

export type ClickReactionOptions = {
  /**
   * Capture-time mono of an event. Reaction probes store the click's capture mono, so a caller
   * that re-timed the events (the Player's wall-clock fallback) passes the original values here,
   * as for `detectPointerSignals`.
   */
  captureMonoOf?: (event: WebBlackboxEvent) => number;
};

/** The reaction probe of a click, or `null`; see `createClickReactionLookup`. */
export type ClickReactionLookup = (click: WebBlackboxEvent) => ClickReaction | null;

export type EventPhraseVerb =
  | "click"
  | "double-click"
  | "right-click"
  | "middle-click"
  | "type"
  | "submit"
  | "key"
  | "marker"
  | "drag"
  | "scroll"
  | "page-load"
  | "reload"
  | "route"
  | "request"
  | "websocket"
  | "console"
  | "exception"
  | "storage"
  | "screenshot"
  | "other";

/** The parts of a one-line summary; the Player turns them into a sentence per locale. */
export type EventPhrase = {
  verb: EventPhraseVerb;
  /** What was acted on: visible text, accessible name or the element kind. */
  target: string | null;
  /** The page route at the time (`#/lobby`), when known. */
  route: string | null;
  /** The key, URL, status or message the verb is about. */
  detail: string | null;
};

const DEFAULT_MAX_ITEMS = 8;
const LABEL_MAX = 160;
const BUTTON_NAMES: Readonly<Record<number, PointerButtonName>> = {
  0: "left",
  1: "middle",
  2: "right",
  3: "back",
  4: "forward"
};
const ID_SEGMENT = /^\d+$|^[0-9a-f-]{8,}$/i;
const NAVIGATION_TYPES = new Set(["nav.commit", "nav.reload"]);
const ROUTE_TYPES = new Set(["nav.history.push", "nav.history.replace", "nav.hash"]);
const CLICK_REACTION_TOLERANCE_MS = 1;

/** Reads the target of a user action; `null` for events without one. */
export function inspectEventTarget(event: WebBlackboxEvent): InspectedTarget | null {
  const data = asRecord(event.data);
  const target = asRecord(data?.target);

  if (!target) {
    return null;
  }

  const readable = asRecord(target.readable);
  const recordedSelector = asString(target.selector);
  const selector = readReadableSelector(target) ?? null;
  const viewport = asRecord(data?.viewport);
  const frameOffset = asRecord(data?.frameOffset);
  const x = asNumber(data?.x);
  const y = asNumber(data?.y);
  const button = asNumber(data?.button);
  const viewportWidth = asNumber(viewport?.w);
  const viewportHeight = asNumber(viewport?.h);
  const offsetX = asNumber(frameOffset?.x);
  const offsetY = asNumber(frameOffset?.y);

  return {
    selector,
    selectorMasked: !selector && recordedSelector !== undefined,
    text: readableName(readable),
    role: asString(readable?.role) ?? null,
    testId: unmasked(asString(readable?.testId)),
    href: unmasked(asString(target.href)),
    element: describeElement(target),
    rect: readRect(asRecord(target.rect)),
    viewport:
      viewportWidth !== undefined && viewportWidth > 0 && viewportHeight && viewportHeight > 0
        ? { width: viewportWidth, height: viewportHeight }
        : null,
    frameOffset: offsetX !== undefined && offsetY !== undefined ? { x: offsetX, y: offsetY } : null,
    pointer:
      x !== undefined && y !== undefined
        ? {
            x,
            y,
            button: button === undefined ? null : (BUTTON_NAMES[button] ?? null),
            modifiers: readModifiers(data)
          }
        : null
  };
}

/** The `user.click.reaction` probe that followed a click, if the capture recorded one. */
export function findClickReaction(
  events: readonly WebBlackboxEvent[],
  click: WebBlackboxEvent,
  options: ClickReactionOptions = {}
): ClickReaction | null {
  return createClickReactionLookup(events, options)(click);
}

/**
 * Indexes the `user.click.reaction` probes once (sorted by the click's capture mono), so looking
 * up many clicks does not scan every event each time.
 */
export function createClickReactionLookup(
  events: readonly WebBlackboxEvent[],
  options: ClickReactionOptions = {}
): ClickReactionLookup {
  const captureMonoOf = options.captureMonoOf ?? ((event: WebBlackboxEvent) => event.mono);
  const probes: Array<{ clickMono: number; reaction: ClickReaction }> = [];

  for (const event of events) {
    const data = event.type === "user.click.reaction" ? asRecord(event.data) : null;
    const clickMono = asNumber(data?.clickMono);

    if (clickMono !== undefined) {
      probes.push({
        clickMono,
        reaction: {
          mutated: data?.mutated === true,
          latencyMs: asNumber(data?.latencyMs) ?? null,
          windowMs: asNumber(data?.windowMs) ?? null
        }
      });
    }
  }

  probes.sort((left, right) => left.clickMono - right.clickMono);

  return (click) => {
    const clickMono = captureMonoOf(click);
    let low = 0;
    let high = probes.length;

    while (low < high) {
      const middle = (low + high) >> 1;
      const probe = probes[middle];

      if (probe && probe.clickMono < clickMono - CLICK_REACTION_TOLERANCE_MS) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    const candidate = probes[low];
    return candidate && Math.abs(candidate.clickMono - clickMono) <= CLICK_REACTION_TOLERANCE_MS
      ? { ...candidate.reaction }
      : null;
  };
}

/**
 * What an action caused: counts, and the notable items in time order. Failed requests on the same
 * endpoint pattern fold into one item (`401 ×3 GET …/chats/*`); successful requests are counted,
 * not listed.
 */
export function summarizeActionConsequences(input: ActionConsequenceInput): ActionConsequences {
  const maxItems = Math.max(1, input.maxItems ?? DEFAULT_MAX_ITEMS);
  const { startMono } = input;
  const notable: ActionConsequence[] = [];
  const failureByKey = new Map<string, ActionConsequence>();
  const requestEventIds = new Set<string>();
  const counts = { failed: 0, console: 0, exceptions: 0, sockets: 0, navigations: 0 };
  // In start order, so a folded failure keeps the earliest request of its endpoint.
  const requests = [...input.requests].sort((left, right) => left.startMono - right.startMono);

  for (const request of requests) {
    for (const eventId of request.eventIds ?? []) {
      requestEventIds.add(eventId);
    }

    if (!isProblemRequest({ ...request, status: request.status ?? undefined, eventIds: [] })) {
      continue;
    }

    counts.failed += 1;
    const method = (request.method ?? "GET").toUpperCase();
    const status = typeof request.status === "number" ? request.status : null;
    const key = `${method} ${status ?? "failed"} ${endpointPattern(request.url)}`;
    const folded = failureByKey.get(key);

    if (folded) {
      failureByKey.set(key, { ...folded, count: folded.count + 1 });
      continue;
    }

    failureByKey.set(key, {
      kind: "request",
      eventId: request.eventIds?.[0] ?? request.reqId,
      mono: request.startMono,
      offsetMs: Math.max(0, request.startMono - startMono),
      label: compact(request.url),
      method,
      status,
      failed: true,
      reqId: request.reqId,
      count: 1
    });
  }

  notable.push(...failureByKey.values());

  for (const event of input.events) {
    if (event.id === input.triggerEventId) {
      continue;
    }

    const item = notableEvent(event, startMono, requestEventIds);

    if (!item) {
      continue;
    }

    if (item.kind === "console-error") {
      counts.console += 1;
    } else if (item.kind === "exception") {
      counts.exceptions += 1;
    } else if (item.kind === "websocket") {
      counts.sockets += 1;
    } else {
      counts.navigations += 1;
    }

    notable.push(item);
  }

  notable.sort((left, right) => left.mono - right.mono);

  return {
    durationMs: Math.max(0, input.endMono - startMono),
    requests: input.requests.length,
    failedRequests: counts.failed,
    consoleErrors: counts.console,
    exceptions: counts.exceptions,
    webSockets: counts.sockets,
    navigations: counts.navigations,
    items: notable.slice(0, maxItems),
    hiddenItems: Math.max(0, notable.length - maxItems),
    firstFailure: notable.find((item) => item.failed) ?? null,
    firstFailedRequest: notable.find((item) => item.kind === "request" && item.failed) ?? null
  };
}

/** The parts of the one-line summary of an event. */
export function describeEventPhrase(
  event: WebBlackboxEvent,
  options: { route?: string | null } = {}
): EventPhrase {
  const data = asRecord(event.data);
  const route = options.route ?? null;
  const phrase = (
    verb: EventPhraseVerb,
    target: string | null,
    detail: string | null
  ): EventPhrase => ({ verb, target, route, detail });

  switch (event.type) {
    case "user.click": {
      const button = asNumber(data?.button);
      const verb = button === 2 ? "right-click" : button === 1 ? "middle-click" : "click";
      return phrase(verb, targetName(data), null);
    }
    case "user.dblclick":
      return phrase("double-click", targetName(data), null);
    case "user.contextmenu":
      return phrase("right-click", targetName(data), null);
    case "user.auxclick":
      return phrase("middle-click", targetName(data), null);
    case "user.input":
      return phrase("type", targetName(data), null);
    case "user.submit":
      return phrase("submit", targetName(data), null);
    case "user.keydown":
      return phrase("key", targetName(data), asString(data?.key) ?? asString(data?.code) ?? null);
    case "user.marker":
      return phrase("marker", null, asString(data?.label) ?? asString(data?.message) ?? null);
    case "user.drag.start":
      return phrase("drag", targetName(data), null);
    case "user.scroll":
    case "user.wheel":
      return phrase("scroll", null, null);
    case "nav.reload":
      return phrase("reload", null, routeOf(readUrl(data)));
    case "nav.commit":
      return phrase("page-load", null, routeOf(readUrl(data)));
    case "network.ws.open":
    case "network.ws.close":
    case "network.ws.frame":
      return phrase("websocket", null, compact(readUrl(data)) || null);
    case "screen.screenshot":
      return phrase("screenshot", null, null);
    default:
      break;
  }

  if (ROUTE_TYPES.has(event.type)) {
    return phrase("route", null, routeOf(readUrl(data)));
  }

  if (event.type.startsWith("network.")) {
    const request = asRecord(data?.request);
    const method = asString(data?.method) ?? asString(request?.method) ?? "";
    const url = readUrl(data) || asString(request?.url) || "";
    return phrase("request", null, `${method ? `${method.toUpperCase()} ` : ""}${compact(url)}`);
  }

  if (event.type.startsWith("error.")) {
    return phrase("exception", null, readMessage(data) ?? event.type);
  }

  if (event.type.startsWith("console.")) {
    return phrase("console", null, readMessage(data));
  }

  if (event.type.startsWith("storage.")) {
    return phrase("storage", null, asString(data?.key) ?? asString(data?.name) ?? null);
  }

  return phrase("other", null, event.type);
}

/** `https://h/a/7/b?x` → `h/a/*\/b`: the endpoint pattern failures fold by. */
export function endpointPattern(url: string): string {
  const parsed = parseUrl(url);
  const path = parsed ? parsed.pathname : (url.split(/[?#]/)[0] ?? url);
  const segments = path.split("/").map((segment) => (ID_SEGMENT.test(segment) ? "*" : segment));
  return `${parsed?.host ?? ""}${segments.join("/")}`;
}

function notableEvent(
  event: WebBlackboxEvent,
  startMono: number,
  requestEventIds: ReadonlySet<string>
): ActionConsequence | null {
  const data = asRecord(event.data);
  const base = {
    eventId: event.id,
    mono: event.mono,
    offsetMs: Math.max(0, event.mono - startMono),
    method: null,
    status: null,
    reqId: null,
    count: 1
  };

  if (NAVIGATION_TYPES.has(event.type)) {
    return { ...base, kind: "page-load", label: routeOf(readUrl(data)) ?? "", failed: false };
  }

  if (ROUTE_TYPES.has(event.type)) {
    return { ...base, kind: "route", label: routeOf(readUrl(data)) ?? "", failed: false };
  }

  if (event.type === "network.ws.open") {
    return { ...base, kind: "websocket", label: compact(readUrl(data)), failed: false };
  }

  if (requestEventIds.has(event.id) || event.type.startsWith("network.")) {
    return null;
  }

  if (event.type.startsWith("error.")) {
    return { ...base, kind: "exception", label: readMessage(data) ?? event.type, failed: true };
  }

  if (readConsoleLevel(event) !== null && isProblemEvent(event)) {
    return { ...base, kind: "console-error", label: readMessage(data) ?? event.type, failed: true };
  }

  return null;
}

function targetName(data: Record<string, unknown> | null): string | null {
  const target = asRecord(data?.target);

  if (!target) {
    return null;
  }

  const readable = asRecord(target.readable);
  return readableName(readable) ?? asString(readable?.role) ?? lowerTag(target);
}

function readableName(readable: Record<string, unknown> | null): string | null {
  const name =
    asString(readable?.text) ?? asString(readable?.ariaLabel) ?? asString(readable?.name);
  return name && !isMaskedValue(name) ? name : null;
}

function describeElement(target: Record<string, unknown>): string | null {
  const tag = lowerTag(target);

  if (!tag) {
    return null;
  }

  const id = unmasked(asString(target.idToken));
  const classes = Array.isArray(target.classTokens)
    ? target.classTokens.filter(
        (token): token is string =>
          typeof token === "string" && token.length > 0 && !isMaskedValue(token)
      )
    : [];
  const attributes = [
    id ? `id="${id}"` : "",
    classes.length > 0 ? `class="${classes.join(" ")}"` : ""
  ].filter(Boolean);
  return attributes.length > 0 ? `<${tag} ${attributes.join(" ")}>` : `<${tag}>`;
}

function lowerTag(target: Record<string, unknown>): string | null {
  return asString(target.tag)?.toLowerCase() ?? null;
}

function readRect(rect: Record<string, unknown> | null): InspectedRect | null {
  const x = asNumber(rect?.x);
  const y = asNumber(rect?.y);
  const width = asNumber(rect?.w);
  const height = asNumber(rect?.h);

  return x !== undefined &&
    y !== undefined &&
    width !== undefined &&
    width > 0 &&
    height !== undefined &&
    height > 0
    ? { x, y, width, height }
    : null;
}

function readModifiers(data: Record<string, unknown> | null): string[] {
  return (
    [
      ["ctrlKey", "Ctrl"],
      ["altKey", "Alt"],
      ["shiftKey", "Shift"],
      ["metaKey", "Meta"]
    ] as const
  ).flatMap(([key, label]) => (data?.[key] === true ? [label] : []));
}

function readUrl(data: Record<string, unknown> | null): string {
  return asString(data?.url) ?? asString(asRecord(data?.frame)?.url) ?? "";
}

function routeOf(url: string): string | null {
  return url ? routeLabelOf(url) : null;
}

function readMessage(data: Record<string, unknown> | null): string | null {
  const text =
    asString(data?.message) ??
    asString(data?.text) ??
    asString(data?.reason) ??
    asString(asRecord(data?.error)?.message);
  return text ? compact(text.split("\n")[0] ?? text) : null;
}

function compact(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LABEL_MAX ? `${trimmed.slice(0, LABEL_MAX - 1)}…` : trimmed;
}

function unmasked(value: string | undefined): string | null {
  return value && !isMaskedValue(value) ? value : null;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
