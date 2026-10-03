import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { readReadableSelector } from "./pointer-insights.js";

/** A click this soon after a long press or drag is the browser's follow-up click, not a new one. */
const FOLLOW_UP_CLICK_MS = 150;
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
    case "user.keydown":
    case "user.marker":
      return true;
    case "user.auxclick":
      return asNumber(asRecord(event.data)?.button) === 1;
    case "user.pointerup":
      return asRecord(event.data)?.longPress === true;
    default:
      return false;
  }
}

/**
 * Playwright statements replaying recorded navigation and user actions, in order. Readable
 * selectors (recorded when the profile allows readable actions) are preferred; targets the
 * profile kept hashed become comments instead of selectors that cannot match.
 */
export function buildPlaywrightActionLines(events: readonly WebBlackboxEvent[]): string[] {
  const lines: string[] = [];
  let suppressClickUntilMono = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    if (event.type === "user.click" && event.mono <= suppressClickUntilMono) {
      continue;
    }

    const data = asRecord(event.data);

    if (
      (event.type === "user.pointerup" && data?.longPress === true) ||
      event.type === "user.drag.end"
    ) {
      suppressClickUntilMono = event.mono + FOLLOW_UP_CLICK_MS;
    }

    lines.push(...toPlaywrightLines(event, data));
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
      return url ? [`  await page.goto(${JSON.stringify(url)});`] : [];
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
      return data?.longPress === true
        ? clickLines(event, data, "click", { delay: Math.round(asNumber(data.holdMs) ?? 0) })
        : [];
    case "user.hover": {
      const selector = readSelector(data?.target);
      return selector
        ? [`  await page.hover(${JSON.stringify(selector)});`]
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
    case "user.keydown": {
      const key = asString(data?.key);
      return key ? [`  await page.keyboard.press(${JSON.stringify(key)});`] : [];
    }
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

  const args = [JSON.stringify(selector), ...(options ? [JSON.stringify(options)] : [])];
  return [`  await page.${method}(${args.join(", ")});`];
}

function dragLines(data: Record<string, unknown> | null): string[] {
  const source = readSelector(data?.target);
  const destination = readSelector(data?.dropTarget);

  if (data?.kind === "dnd" && source && destination) {
    return [`  await page.dragAndDrop(${JSON.stringify(source)}, ${JSON.stringify(destination)});`];
  }

  const startX = asNumber(data?.startX);
  const startY = asNumber(data?.startY);
  const x = asNumber(data?.x);
  const y = asNumber(data?.y);

  if (startX === undefined || startY === undefined || x === undefined || y === undefined) {
    return ["  // drag skipped (no coordinates)"];
  }

  return [
    `  await page.mouse.move(${startX}, ${startY});`,
    "  await page.mouse.down();",
    `  await page.mouse.move(${x}, ${y}, { steps: 10 });`,
    "  await page.mouse.up();"
  ];
}

function wheelLines(data: Record<string, unknown> | null): string[] {
  const deltaX = asNumber(data?.deltaX) ?? 0;
  const deltaY = asNumber(data?.deltaY) ?? 0;
  const x = asNumber(data?.x);
  const y = asNumber(data?.y);
  const move = x !== undefined && y !== undefined ? [`  await page.mouse.move(${x}, ${y});`] : [];
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

function inputLines(data: Record<string, unknown> | null): string[] {
  const selector = readSelector(data?.target);
  const value = asString(data?.value);

  if (!selector) {
    return ["  // input skipped (no selector)"];
  }

  if (!value || value === "[MASKED]") {
    return [`  // input on ${JSON.stringify(selector)} was masked in capture`];
  }

  return [`  await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)});`];
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
