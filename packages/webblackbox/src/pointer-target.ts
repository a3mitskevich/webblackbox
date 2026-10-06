import {
  READABLE_TARGET_TEXT_MAX_CHARS,
  allowsReadablePointerTargets,
  keepReadableSelector,
  maskPointerLabel,
  type CapturePolicy,
  type PointerTargetRect,
  type PointerViewportGeometry,
  type ReadablePointerTarget,
  type RedactionProfile
} from "@webblackbox/protocol";

import { isCoveredByBlockedSelector } from "./input-value-policy.js";

const READABLE_ATTRIBUTE_MAX_CHARS = 80;
/** Raw text read for a label before whitespace is collapsed and it is clipped. */
const LABEL_SCAN_MAX_CHARS = READABLE_TARGET_TEXT_MAX_CHARS * 4;
const LABEL_SCAN_MAX_NODES = 400;
const LABEL_HIDDEN_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TEXTAREA",
  "SELECT",
  "INPUT"
]);
const EDITABLE_SELECTOR = "[contenteditable='true'], [contenteditable='plaintext-only']";
const SELECTOR_ATTRIBUTE_MAX_CHARS = 100;
const SELECTOR_PATH_MAX_DEPTH = 5;
const STABLE_ID_PATTERN = /^[A-Za-z][\w-]{0,63}$/;
const GENERATED_ID_PATTERN = /\d{4,}/;
const TEST_ID_ATTRIBUTES = ["data-testid", "data-test-id", "data-qa"] as const;
const BUTTON_LIKE_INPUT_TYPES = new Set(["button", "submit", "reset"]);

/** Elements a user can point at with intent: hover dwell is tracked only over these. */
export const INTERACTIVE_ELEMENT_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "label",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='option']",
  "[tabindex]:not([tabindex='-1'])",
  "[onclick]"
].join(", ");

const IMPLICIT_ROLES: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  SUMMARY: "button",
  IMG: "img",
  OPTION: "option",
  LI: "listitem",
  NAV: "navigation",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading"
};

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  search: "searchbox"
};

export function readDataTestId(target: Element): string | undefined {
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = target.getAttribute(attribute);

    if (value !== null) {
      return value;
    }
  }

  return undefined;
}

/**
 * Human-readable description of a pointer target, or undefined when the profile keeps targets
 * hashed or the element sits under a blocked selector. Field values are never read: only labels.
 */
export function buildReadableTarget(
  element: Element,
  policy: CapturePolicy
): ReadablePointerTarget | undefined {
  if (
    !allowsReadablePointerTargets(policy) ||
    isCoveredByBlockedSelector(element, policy.redaction)
  ) {
    return undefined;
  }

  // Labels are page text: the profile's DOM rules mask them before clipping, as in the DOM
  // snapshot, so a pattern is never cut in half by the length limit.
  const rules = policy.redaction;
  const mask = (value: string | null | undefined): string | undefined =>
    typeof value === "string" ? maskPointerLabel(value, rules) : undefined;
  const css = buildReadableSelector(element);
  const readable: ReadablePointerTarget = {
    role: clip(mask(element.getAttribute("role") ?? resolveImplicitRole(element))),
    ariaLabel: clip(mask(element.getAttribute("aria-label"))),
    text: readVisibleLabel(element, policy.redaction),
    testId: clip(mask(readDataTestId(element))),
    name: clip(mask(element.getAttribute("name"))),
    css: css === undefined ? undefined : keepReadableSelector(css, rules)
  };
  const entries = Object.entries(readable).filter(([, value]) => value !== undefined);

  return entries.length > 0 ? (Object.fromEntries(entries) as ReadablePointerTarget) : undefined;
}

/**
 * CSS selector that matches only `element` in its document or shadow root, preferring test ids,
 * stable ids, `name` and `aria-label` over a structural path. Undefined when nothing is unique.
 */
export function buildReadableSelector(element: Element): string | undefined {
  const root = resolveQueryRoot(element);

  if (!root) {
    return undefined;
  }

  const tag = element.tagName.toLowerCase();
  const candidates = [
    ...anchorCandidates(element),
    attributeSelector(tag, "name", element.getAttribute("name")),
    attributeSelector(tag, "aria-label", element.getAttribute("aria-label"))
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of candidates) {
    if (isUniqueSelector(root, candidate)) {
      return candidate;
    }
  }

  return buildStructuralSelector(element, root);
}

/** Closest interactive element for a hover target, or null. */
export function resolveInteractiveElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) {
    return null;
  }

  try {
    return target.closest(INTERACTIVE_ELEMENT_SELECTOR);
  } catch {
    return null;
  }
}

export function readViewportGeometry(): PointerViewportGeometry | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return {
    w: round(window.innerWidth),
    h: round(window.innerHeight),
    dpr: round(window.devicePixelRatio || 1),
    scrollX: round(window.scrollX),
    scrollY: round(window.scrollY)
  };
}

export function readTargetRect(target: EventTarget | null): PointerTargetRect | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  try {
    const rect = target.getBoundingClientRect();
    return { x: round(rect.left), y: round(rect.top), w: round(rect.width), h: round(rect.height) };
  } catch {
    return undefined;
  }
}

/**
 * Offset of this frame inside the top-level viewport, summed over nested frames. Undefined in the
 * top frame and whenever a frame element is unreachable (cross-origin parents).
 */
export function readFrameOffset(): { x: number; y: number } | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    if (window.top === window) {
      return undefined;
    }

    let current: Window = window;
    let x = 0;
    let y = 0;

    while (current !== current.top) {
      const frame = current.frameElement;

      if (!frame) {
        return undefined;
      }

      const rect = frame.getBoundingClientRect();
      x += rect.left + frame.clientLeft;
      y += rect.top + frame.clientTop;
      current = current.parent;
    }

    return { x: round(x), y: round(y) };
  } catch {
    return undefined;
  }
}

export function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function readVisibleLabel(element: Element, redaction: RedactionProfile): string | undefined {
  if (element instanceof HTMLInputElement) {
    // Only button-like inputs show their value as a label; other values are user data.
    return BUTTON_LIKE_INPUT_TYPES.has(element.type.toLowerCase())
      ? clipText(maskPointerLabel(element.value, redaction))
      : undefined;
  }

  if (isHiddenFromLabel(element, redaction) || element.closest(EDITABLE_SELECTOR) !== null) {
    return undefined;
  }

  return clipText(maskPointerLabel(readLabelText(element, redaction), redaction));
}

/**
 * Text under `element` up to a little past the label limit. Unlike `textContent` it never reads
 * the whole subtree, and it skips descendants that are blocked, editable, fields or scripts, so a
 * click on a wrapper cannot pull a blocked child's text into the label.
 */
function readLabelText(element: Element, redaction: RedactionProfile): string {
  let text = "";
  let visited = 0;
  let node: Node | null = element.firstChild;

  while (node && visited < LABEL_SCAN_MAX_NODES && text.length <= LABEL_SCAN_MAX_CHARS) {
    visited += 1;
    let descend = false;

    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? "";
    } else if (node instanceof Element) {
      descend = !isHiddenFromLabel(node, redaction);
    }

    node = nextLabelNode(node, element, descend);
  }

  return text;
}

/** Next node in document order inside `root`, entering `node` only when `descend` is set. */
function nextLabelNode(node: Node, root: Node, descend: boolean): Node | null {
  if (descend && node.firstChild) {
    return node.firstChild;
  }

  let current: Node | null = node;

  while (current && current !== root) {
    if (current.nextSibling) {
      return current.nextSibling;
    }

    current = current.parentNode;
  }

  return null;
}

function isHiddenFromLabel(element: Element, redaction: RedactionProfile): boolean {
  return (
    LABEL_HIDDEN_TAGS.has(element.tagName) ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    element.matches(EDITABLE_SELECTOR) ||
    isCoveredByBlockedSelector(element, redaction)
  );
}

function resolveImplicitRole(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    return INPUT_ROLES[element.type.toLowerCase()] ?? "textbox";
  }

  if (element.tagName === "A" && !element.hasAttribute("href")) {
    return undefined;
  }

  return IMPLICIT_ROLES[element.tagName];
}

function anchorCandidates(element: Element): string[] {
  const candidates: string[] = [];

  for (const attribute of TEST_ID_ATTRIBUTES) {
    const selector = attributeSelector("", attribute, element.getAttribute(attribute));

    if (selector) {
      candidates.push(selector);
    }
  }

  if (isStableId(element.id)) {
    candidates.push(`#${escapeIdentifier(element.id)}`);
  }

  return candidates;
}

function buildStructuralSelector(element: Element, root: ParentNode): string | undefined {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current && segments.length < SELECTOR_PATH_MAX_DEPTH) {
    const anchor = anchorCandidates(current).find((candidate) => isUniqueSelector(root, candidate));

    if (anchor) {
      segments.unshift(anchor);
      const selector = segments.join(" > ");
      return isUniqueSelector(root, selector) ? selector : undefined;
    }

    segments.unshift(structuralSegment(current));
    const selector = segments.join(" > ");

    if (isUniqueSelector(root, selector)) {
      return selector;
    }

    current = current.parentElement;
  }

  return undefined;
}

function structuralSegment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;

  if (!parent) {
    return tag;
  }

  let index = 0;
  let sameTagCount = 0;

  for (const sibling of Array.from(parent.children)) {
    if (sibling.tagName === element.tagName) {
      sameTagCount += 1;

      if (sibling === element) {
        index = sameTagCount;
      }
    }
  }

  return sameTagCount > 1 ? `${tag}:nth-of-type(${index})` : tag;
}

function attributeSelector(
  tag: string,
  attribute: string,
  value: string | null
): string | undefined {
  if (
    value === null ||
    value.length === 0 ||
    value.length > SELECTOR_ATTRIBUTE_MAX_CHARS ||
    /[\n\r\f]/.test(value)
  ) {
    return undefined;
  }

  return `${tag}[${attribute}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

function isStableId(id: string): boolean {
  return STABLE_ID_PATTERN.test(id) && !GENERATED_ID_PATTERN.test(id);
}

function escapeIdentifier(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/^(\d)|[^\w-]/g, (match, digit: string | undefined) =>
    digit ? `\\3${digit} ` : `\\${match}`
  );
}

function isUniqueSelector(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function resolveQueryRoot(element: Element): ParentNode | null {
  const root = element.getRootNode();

  if (root instanceof Document || root instanceof DocumentFragment) {
    return root;
  }

  return null;
}

function normalizeWhitespace(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function clip(value: string | undefined): string | undefined {
  const normalized = normalizeWhitespace(value);
  return normalized === undefined ? undefined : normalized.slice(0, READABLE_ATTRIBUTE_MAX_CHARS);
}

function clipText(value: string | null | undefined): string | undefined {
  const normalized = normalizeWhitespace(value);

  if (normalized === undefined) {
    return undefined;
  }

  return normalized.length > READABLE_TARGET_TEXT_MAX_CHARS
    ? `${normalized.slice(0, READABLE_TARGET_TEXT_MAX_CHARS - 1)}…`
    : normalized;
}
