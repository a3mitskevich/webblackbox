import type { WebBlackboxEvent } from "@webblackbox/protocol";

import {
  findGestureClickIds,
  isLongPress,
  isMaskedValue,
  readReadableSelector
} from "./pointer-insights.js";

const HASHED_SELECTOR_PATTERN = /^selector:|\[REDACTED|\[(?:id|class):t_/;

/** Events that turn into Playwright statements (the rest would only eat the action budget). */
export function isPlaywrightReplayableEvent(event: WebBlackboxEvent): boolean {
  switch (event.type) {
    case "nav.commit":
    case "nav.hash":
    case "user.click":
    case "user.dblclick":
    case "user.contextmenu":
    case "user.hover":
    case "user.drag.end":
    case "user.wheel":
    case "user.input":
    case "user.scroll":
    case "user.marker":
      return true;
    case "user.keydown":
      return readReplayableKey(asRecord(event.data)) !== null;
    case "user.auxclick":
      return asNumber(asRecord(event.data)?.button) === 1;
    case "user.pointerup":
      return isLongPress(event);
    default:
      return false;
  }
}

/**
 * Events a Playwright script replays, capped at `maxActions`. The browser's click after a long
 * press or drag is dropped first so it neither costs budget nor gets cut off from its gesture.
 */
export function selectPlaywrightActions(
  events: readonly WebBlackboxEvent[],
  maxActions: number
): WebBlackboxEvent[] {
  const gestureClicks = findGestureClickIds(events);
  return events
    .filter((event) => isPlaywrightReplayableEvent(event) && !gestureClicks.has(event.id))
    .slice(0, maxActions);
}

/**
 * Playwright statements replaying recorded navigation and user actions, in order. Readable
 * selectors (recorded when the profile allows readable actions) are preferred; targets the
 * profile kept hashed become comments instead of selectors that cannot match.
 */
export function buildPlaywrightActionLines(events: readonly WebBlackboxEvent[]): string[] {
  const lines: string[] = [];
  // The long press or drag itself is replayed; the click the browser added after it is not.
  const gestureClicks = findGestureClickIds(events);

  for (const event of events) {
    if (!gestureClicks.has(event.id)) {
      lines.push(...toPlaywrightLines(event, asRecord(event.data)));
    }
  }

  return lines;
}

function toPlaywrightLines(
  event: WebBlackboxEvent,
  data: Record<string, unknown> | null
): string[] {
  switch (event.type) {
    case "nav.commit":
    case "nav.hash": {
      const url = asString(data?.url);
      return url ? [`  await page.goto(${toJsLiteral(url)});`] : [];
    }
    case "user.click":
    case "user.dblclick":
      return clickLines(event, data, event.type === "user.dblclick" ? "dblclick" : "click");
    case "user.contextmenu":
      return clickLines(event, data, "click", { button: "right" });
    case "user.auxclick":
      return asNumber(data?.button) === 1
        ? clickLines(event, data, "click", { button: "middle" })
        : [];
    case "user.pointerup":
      return isLongPress(event)
        ? clickLines(event, data, "click", { delay: Math.round(asNumber(data?.holdMs) ?? 0) })
        : [];
    case "user.hover": {
      const selector = readSelector(data?.target);
      return selector
        ? [`  await page.hover(${toJsLiteral(selector)});`]
        : [skipped(event, data?.target)];
    }
    case "user.drag.end":
      return dragLines(data);
    case "user.wheel":
      return wheelLines(data);
    case "user.input":
      return inputLines(data);
    case "user.scroll": {
      const x = asNumber(data?.scrollX) ?? 0;
      const y = asNumber(data?.scrollY) ?? 0;
      return [`  await page.evaluate(([x, y]) => window.scrollTo(x, y), [${x}, ${y}] as const);`];
    }
    case "user.keydown":
      return keydownLines(data);
    case "user.marker":
      return ["  // Marker captured during session"];
    default:
      return [];
  }
}

function clickLines(
  event: WebBlackboxEvent,
  data: Record<string, unknown> | null,
  method: "click" | "dblclick",
  options?: Record<string, string | number>
): string[] {
  const selector = readSelector(data?.target);

  if (!selector) {
    return [skipped(event, data?.target)];
  }

  const args = [toJsLiteral(selector), ...(options ? [JSON.stringify(options)] : [])];
  return [`  await page.${method}(${args.join(", ")});`];
}

function dragLines(data: Record<string, unknown> | null): string[] {
  if (data?.cancelled === true || data?.dropped === false) {
    return ["  // drag skipped (cancelled before the drop)"];
  }

  const source = readSelector(data?.target);
  const destination = readSelector(data?.dropTarget);

  if (data?.kind === "dnd" && source && destination) {
    return [`  await page.dragAndDrop(${toJsLiteral(source)}, ${toJsLiteral(destination)});`];
  }

  const start = toPagePoint(data, asNumber(data?.startX), asNumber(data?.startY));
  const end = toPagePoint(data, asNumber(data?.x), asNumber(data?.y));

  if (!start || !end) {
    return ["  // drag skipped (no coordinates)"];
  }

  return [
    `  await page.mouse.move(${start.x}, ${start.y});`,
    "  await page.mouse.down();",
    `  await page.mouse.move(${end.x}, ${end.y}, { steps: 10 });`,
    "  await page.mouse.up();"
  ];
}

function wheelLines(data: Record<string, unknown> | null): string[] {
  const deltaX = asNumber(data?.deltaX) ?? 0;
  const deltaY = asNumber(data?.deltaY) ?? 0;
  const point = toPagePoint(data, asNumber(data?.x), asNumber(data?.y));
  const move = point ? [`  await page.mouse.move(${point.x}, ${point.y});`] : [];
  const wheel = `  await page.mouse.wheel(${deltaX}, ${deltaY});`;

  return data?.zoom === true
    ? [
        ...move,
        "  await page.keyboard.down('Control');",
        wheel,
        "  await page.keyboard.up('Control');"
      ]
    : [...move, wheel];
}

function keydownLines(data: Record<string, unknown> | null): string[] {
  const key = readReplayableKey(data);
  return key ? [`  await page.keyboard.press(${toJsLiteral(key)});`] : [];
}

/**
 * The recorded key, or null when the capture redacted it (masked, hashed, flagged or empty).
 * Redacted keys are skipped entirely, so typing into a protected field costs no action budget.
 */
function readReplayableKey(data: Record<string, unknown> | null): string | null {
  const key = asString(data?.key);
  return key && !isMaskedValue(key) && data?.redacted !== true && data?.masked !== true
    ? key
    : null;
}

function inputLines(data: Record<string, unknown> | null): string[] {
  const selector = readSelector(data?.target);
  const value = asString(data?.value);

  if (!selector) {
    return ["  // input skipped (no selector)"];
  }

  if (!value || value === "[MASKED]") {
    return [`  // input on ${toJsLiteral(selector)} was masked in capture`];
  }

  return [`  await page.fill(${toJsLiteral(selector)}, ${toJsLiteral(value)});`];
}

/**
 * Frame-relative client point moved into the top viewport that `page.mouse` uses, by the
 * recorded same-origin `frameOffset` (cross-origin frames record none and stay as they are).
 */
function toPagePoint(
  data: Record<string, unknown> | null,
  x: number | undefined,
  y: number | undefined
): { x: number; y: number } | null {
  if (x === undefined || y === undefined) {
    return null;
  }

  const offset = asRecord(data?.frameOffset);
  return { x: x + (asNumber(offset?.x) ?? 0), y: y + (asNumber(offset?.y) ?? 0) };
}

/**
 * JavaScript string literal for archive text. JSON leaves U+2028/U+2029 raw, and those end a
 * `//` comment, so a crafted archive could otherwise put code into the generated test.
 */
function toJsLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function skipped(event: WebBlackboxEvent, target: unknown): string {
  const hashed = asString(asRecord(target)?.selector) !== undefined;
  return hashed
    ? `  // ${event.type} skipped (the recording profile kept the target hashed)`
    : `  // ${event.type} skipped (no selector)`;
}

/** Readable selector first, then a plain recorded selector; hashed selectors never match. */
function readSelector(target: unknown): string | null {
  const readable = readReadableSelector(target);

  if (readable) {
    return readable;
  }

  const selector = asString(asRecord(target)?.selector);

  if (!selector || selector === "unknown" || HASHED_SELECTOR_PATTERN.test(selector)) {
    return null;
  }

  return selector;
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
