import type { WebBlackboxEvent, WebBlackboxEventType } from "@webblackbox/protocol";

/** Kind of pointer action shown on the pointer lane. */
export type PointerActionKind =
  | "click"
  | "double"
  | "right"
  | "middle"
  | "hold"
  | "drag"
  | "dnd"
  | "wheel"
  | "zoom"
  | "hover"
  | "selection";

export type PointerTimelineEntry = {
  eventId: string;
  type: WebBlackboxEventType;
  kind: PointerActionKind;
  mono: number;
  t: number;
  /** One-line English description, e.g. `Right click on button "Save"`. */
  label: string;
  /** Frame-relative client coordinates. */
  x?: number;
  y?: number;
  /** Drag start (drags only). */
  startX?: number;
  startY?: number;
  frameOffset?: { x: number; y: number };
  viewport?: { w: number; h: number };
  target?: string;
  /** Readable CSS selector, when the profile recorded one. */
  selector?: string;
  holdMs?: number;
  distance?: number;
};

export type RageClickFinding = {
  startMono: number;
  endMono: number;
  count: number;
  x: number;
  y: number;
  eventIds: string[];
  target?: string;
};

export type DeadClickFinding = {
  eventId: string;
  mono: number;
  x?: number;
  y?: number;
  target?: string;
  /** Where the "no reaction" verdict comes from. */
  evidence: "reaction-probe" | "dom-events";
};

export type PointerSignals = {
  rageClicks: RageClickFinding[];
  deadClicks: DeadClickFinding[];
  /** False when the session holds no DOM reaction data, so dead clicks cannot be judged. */
  deadClickCoverage: boolean;
};

export type RageClickOptions = {
  minClicks?: number;
  windowMs?: number;
  radiusPx?: number;
};

export type DeadClickOptions = {
  windowMs?: number;
};

export const RAGE_CLICK_MIN_CLICKS = 3;
export const RAGE_CLICK_WINDOW_MS = 1_000;
export const RAGE_CLICK_RADIUS_PX = 30;
export const DEAD_CLICK_WINDOW_MS = 1_000;

const KIND_LABELS: Record<PointerActionKind, string> = {
  click: "Click",
  double: "Double click",
  right: "Right click",
  middle: "Middle click",
  hold: "Long press",
  drag: "Drag",
  dnd: "Drag and drop",
  wheel: "Wheel",
  zoom: "Ctrl+wheel zoom",
  hover: "Hover",
  selection: "Text selection"
};

/** Clicks on these never need a visible reaction: they focus or toggle native controls. */
const REACTION_EXEMPT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "LABEL"]);
const REACTION_EXEMPT_ROLES = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio"]);
const DOM_REACTION_TYPES = new Set<WebBlackboxEventType>(["dom.mutation.batch", "dom.rrweb.event"]);
const CLICK_MONO_TOLERANCE_MS = 1;

/** Pointer actions worth a mark on the timeline, in session order. */
export function buildPointerTimeline(events: readonly WebBlackboxEvent[]): PointerTimelineEntry[] {
  const entries: PointerTimelineEntry[] = [];

  for (const event of events) {
    const kind = resolvePointerKind(event);

    if (kind) {
      entries.push(toTimelineEntry(event, kind));
    }
  }

  return entries;
}

/** Human description of a recorded target: `button "Save" (#save)`, or its tag when hashed. */
export function describePointerTarget(value: unknown): string | undefined {
  const target = asRecord(value);

  if (!target) {
    return undefined;
  }

  const readable = asRecord(target.readable);
  const tag = asString(target.tag)?.toLowerCase();
  const role = asString(readable?.role) ?? tag;
  const name = asString(readable?.text) ?? asString(readable?.ariaLabel);
  const css = readReadableSelector(target);
  const head = [role, name ? JSON.stringify(name) : undefined].filter(Boolean).join(" ");

  if (!head) {
    return css;
  }

  return css ? `${head} (${css})` : head;
}

/** Readable CSS selector recorded for a target (never the hashed `selector`). */
export function readReadableSelector(value: unknown): string | undefined {
  const css = asString(asRecord(asRecord(value)?.readable)?.css);
  return css && css.length > 0 ? css : undefined;
}

/**
 * Bursts of at least `minClicks` clicks within `windowMs` around one spot (`radiusPx`, same frame).
 * Consecutive clicks join a burst while each follows the previous within the window.
 */
export function detectRageClicks(
  events: readonly WebBlackboxEvent[],
  options: RageClickOptions = {}
): RageClickFinding[] {
  const minClicks = options.minClicks ?? RAGE_CLICK_MIN_CLICKS;
  const windowMs = options.windowMs ?? RAGE_CLICK_WINDOW_MS;
  const radiusPx = options.radiusPx ?? RAGE_CLICK_RADIUS_PX;
  const clicks = events.filter((event) => event.type === "user.click" && readPoint(event));
  const findings: RageClickFinding[] = [];
  let burst: WebBlackboxEvent[] = [];

  const closeBurst = (): void => {
    const finding = toRageFinding(burst, minClicks, windowMs);

    if (finding) {
      findings.push(finding);
    }

    burst = [];
  };

  for (const click of clicks) {
    const first = burst[0];
    const previous = burst[burst.length - 1];

    if (
      first &&
      previous &&
      (click.frame !== first.frame ||
        click.mono - previous.mono > windowMs ||
        distanceBetween(first, click) > radiusPx)
    ) {
      closeBurst();
    }

    burst.push(click);
  }

  closeBurst();
  return findings;
}

/**
 * Clicks with no DOM change, request or navigation within `windowMs`. Uses the capture agent's
 * reaction probe when present and DOM mutation events otherwise; clicks on form controls are
 * exempt, and sessions with neither source are reported as not covered instead of guessed.
 */
export function detectDeadClicks(
  events: readonly WebBlackboxEvent[],
  options: DeadClickOptions = {}
): { findings: DeadClickFinding[]; coverage: boolean } {
  const windowMs = options.windowMs ?? DEAD_CLICK_WINDOW_MS;
  const reactions = events.filter((event) => event.type === "user.click.reaction");
  const hasDomEvents = events.some((event) => DOM_REACTION_TYPES.has(event.type));
  const findings: DeadClickFinding[] = [];

  events.forEach((event, index) => {
    if (event.type !== "user.click" || isReactionExempt(event)) {
      return;
    }

    const probe = findReactionProbe(reactions, event.mono);
    const evidence = probe ? "reaction-probe" : hasDomEvents ? "dom-events" : null;

    if (evidence === null || (probe && asRecord(probe.data)?.mutated === true)) {
      return;
    }

    if (hasFollowUpReaction(events, index, windowMs, evidence === "dom-events")) {
      return;
    }

    const point = readPoint(event);
    findings.push({
      eventId: event.id,
      mono: event.mono,
      ...(point ? { x: point.x, y: point.y } : {}),
      ...withTarget(asRecord(event.data)?.target),
      evidence
    });
  });

  return { findings, coverage: reactions.length > 0 || hasDomEvents };
}

export function detectPointerSignals(events: readonly WebBlackboxEvent[]): PointerSignals {
  const dead = detectDeadClicks(events);

  return {
    rageClicks: detectRageClicks(events),
    deadClicks: dead.findings,
    deadClickCoverage: dead.coverage
  };
}

function resolvePointerKind(event: WebBlackboxEvent): PointerActionKind | null {
  const data = asRecord(event.data);

  switch (event.type) {
    case "user.click":
      return "click";
    case "user.dblclick":
      return "double";
    case "user.contextmenu":
      return "right";
    case "user.auxclick":
      return asNumber(data?.button) === 1 ? "middle" : null;
    case "user.pointerup":
      return data?.longPress === true ? "hold" : null;
    case "user.drag.end":
      return data?.kind === "dnd" ? "dnd" : "drag";
    case "user.wheel":
      return data?.zoom === true ? "zoom" : "wheel";
    case "user.hover":
      return "hover";
    case "user.selection":
      return "selection";
    default:
      return null;
  }
}

function toTimelineEntry(event: WebBlackboxEvent, kind: PointerActionKind): PointerTimelineEntry {
  const data = asRecord(event.data);
  const point = readPoint(event);
  const target = describePointerTarget(data?.target);
  const selector = readReadableSelector(data?.target);
  const viewport = asRecord(data?.viewport);
  const frameOffset = asRecord(data?.frameOffset);
  const holdMs = asNumber(data?.holdMs);
  const distance = asNumber(data?.distance);
  const startX = asNumber(data?.startX);
  const startY = asNumber(data?.startY);
  const viewportW = asNumber(viewport?.w);
  const viewportH = asNumber(viewport?.h);
  const frameX = asNumber(frameOffset?.x);
  const frameY = asNumber(frameOffset?.y);

  return {
    eventId: event.id,
    type: event.type,
    kind,
    mono: event.mono,
    t: event.t,
    label: describePointerAction(kind, data, target),
    ...(point ? { x: point.x, y: point.y } : {}),
    ...(startX !== undefined && startY !== undefined ? { startX, startY } : {}),
    ...(frameX !== undefined && frameY !== undefined
      ? { frameOffset: { x: frameX, y: frameY } }
      : {}),
    ...(viewportW !== undefined && viewportH !== undefined
      ? { viewport: { w: viewportW, h: viewportH } }
      : {}),
    ...(target ? { target } : {}),
    ...(selector ? { selector } : {}),
    ...(holdMs !== undefined ? { holdMs } : {}),
    ...(distance !== undefined ? { distance } : {})
  };
}

function describePointerAction(
  kind: PointerActionKind,
  data: Record<string, unknown> | null,
  target: string | undefined
): string {
  const details: string[] = [];

  if (kind === "hold") {
    details.push(`${Math.round(asNumber(data?.holdMs) ?? 0)} ms`);
  }

  if (kind === "drag" || kind === "dnd") {
    details.push(`${Math.round(asNumber(data?.distance) ?? 0)} px`);
  }

  if (kind === "hover") {
    details.push(`${Math.round(asNumber(data?.dwellMs) ?? 0)} ms`);
  }

  if (kind === "wheel" || kind === "zoom") {
    details.push(`Δy ${Math.round(asNumber(data?.deltaY) ?? 0)}`);
  }

  if (kind === "selection") {
    details.push(`${Math.round(asNumber(data?.length) ?? 0)} chars`);
  }

  const head =
    details.length > 0 ? `${KIND_LABELS[kind]} (${details.join(", ")})` : KIND_LABELS[kind];
  const dropTarget =
    kind === "drag" || kind === "dnd" ? describePointerTarget(data?.dropTarget) : undefined;
  const on = target ? ` on ${target}` : "";

  return dropTarget ? `${head}${on} to ${dropTarget}` : `${head}${on}`;
}

function toRageFinding(
  burst: readonly WebBlackboxEvent[],
  minClicks: number,
  windowMs: number
): RageClickFinding | null {
  const denseStart = burst.findIndex((click, index) => {
    const last = burst[index + minClicks - 1];
    return last !== undefined && last.mono - click.mono <= windowMs;
  });

  const first = burst[0];
  const last = burst[burst.length - 1];
  const point = first ? readPoint(first) : null;

  if (denseStart < 0 || !first || !last || !point) {
    return null;
  }

  return {
    startMono: first.mono,
    endMono: last.mono,
    count: burst.length,
    x: point.x,
    y: point.y,
    eventIds: burst.map((click) => click.id),
    ...withTarget(asRecord(first.data)?.target)
  };
}

function findReactionProbe(
  reactions: readonly WebBlackboxEvent[],
  clickMono: number
): WebBlackboxEvent | undefined {
  return reactions.find((reaction) => {
    const recorded = asNumber(asRecord(reaction.data)?.clickMono);
    return recorded !== undefined && Math.abs(recorded - clickMono) <= CLICK_MONO_TOLERANCE_MS;
  });
}

function hasFollowUpReaction(
  events: readonly WebBlackboxEvent[],
  clickIndex: number,
  windowMs: number,
  countDomEvents: boolean
): boolean {
  const click = events[clickIndex];

  if (!click) {
    return false;
  }

  for (let index = clickIndex + 1; index < events.length; index += 1) {
    const event = events[index];

    if (!event || event.mono - click.mono > windowMs) {
      break;
    }

    if (
      event.type === "network.request" ||
      event.type.startsWith("nav.") ||
      (countDomEvents && DOM_REACTION_TYPES.has(event.type))
    ) {
      return true;
    }
  }

  return false;
}

function isReactionExempt(event: WebBlackboxEvent): boolean {
  const target = asRecord(asRecord(event.data)?.target);
  const tag = asString(target?.tag)?.toUpperCase();
  const role = asString(asRecord(target?.readable)?.role);

  return (
    (tag !== undefined && REACTION_EXEMPT_TAGS.has(tag)) ||
    (role !== undefined && REACTION_EXEMPT_ROLES.has(role)) ||
    asString(target?.href) !== undefined
  );
}

function withTarget(value: unknown): { target?: string } {
  const target = describePointerTarget(value);
  return target ? { target } : {};
}

function readPoint(event: WebBlackboxEvent): { x: number; y: number } | null {
  const data = asRecord(event.data);
  const x = asNumber(data?.x);
  const y = asNumber(data?.y);
  return x !== undefined && y !== undefined ? { x, y } : null;
}

function distanceBetween(left: WebBlackboxEvent, right: WebBlackboxEvent): number {
  const a = readPoint(left);
  const b = readPoint(right);
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Number.POSITIVE_INFINITY;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
