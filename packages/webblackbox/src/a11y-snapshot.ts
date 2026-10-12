import {
  A11Y_SNAPSHOT_LIMITS,
  formatA11yTree,
  recordUrl,
  type A11ySnapshotMasking,
  type A11ySnapshotTrigger,
  type A11yTreeNode,
  type CapturePolicy,
  type DomA11ySnapshotData
} from "@webblackbox/protocol";
import {
  isContentRedactionEnabled,
  maskDomText,
  usesBuiltInHeuristics
} from "@webblackbox/protocol/redaction-rules";

import { isCoveredByBlockedSelector, readCapturableInputValue } from "./input-value-policy.js";
import { sanitizeVisibleText } from "./raw-dom-snapshot.js";

// The page side of `dom.a11y.snapshot`: a minimal accessibility tree (roles, accessible names,
// states, visible text) of what intersects the viewport, computed from the DOM. Chrome's own tree
// (`Accessibility.getFullAXTree`) is not used: on a 15k-element page it took ~1.5 s and 16 MB per
// call, for the whole document. The rules follow the common cases of HTML-AAM and accname;
// exotic ones (CSS generated content, aria-owns) are not modelled.

const SKIPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "HEAD",
  "META",
  "LINK",
  "TITLE",
  "BASE"
]);
const OWN_UI_ATTRIBUTE = "data-webblackbox-indicator";
/** Deepest DOM nesting walked: deeper markup is reported as cut, never a stack overflow. */
const MAX_DOM_DEPTH = 256;
/** How often (in visited elements) the walk checks its time budget. */
const DEADLINE_CHECK_EVERY = 32;
/** Roles whose accessible name is their text: their subtree is not written separately. */
const NAME_FROM_CONTENT_ROLES = new Set([
  "button",
  "link",
  "heading",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "switch",
  "checkbox",
  "radio",
  "columnheader",
  "rowheader",
  "tooltip"
]);
/** Roles that carry a typed value. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const LANDMARK_SCOPE_TAGS = new Set(["ARTICLE", "ASIDE", "MAIN", "NAV", "SECTION"]);
const HEADING_TAG_PATTERN = /^H([1-6])$/;
const INPUT_TYPE_ROLES: Readonly<Record<string, string>> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  file: "button",
  color: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox"
};
const TAG_ROLES: Readonly<Record<string, string>> = {
  ARTICLE: "article",
  ASIDE: "complementary",
  BLOCKQUOTE: "blockquote",
  BUTTON: "button",
  CODE: "code",
  DETAILS: "group",
  DIALOG: "dialog",
  FIELDSET: "group",
  FIGURE: "figure",
  FORM: "form",
  HR: "separator",
  IFRAME: "iframe",
  LI: "listitem",
  MAIN: "main",
  MENU: "list",
  METER: "meter",
  NAV: "navigation",
  OL: "list",
  OPTION: "option",
  OUTPUT: "status",
  P: "paragraph",
  PROGRESS: "progressbar",
  SUMMARY: "button",
  TABLE: "table",
  TD: "cell",
  TEXTAREA: "textbox",
  TH: "columnheader",
  TR: "row",
  UL: "list"
};

export type A11ySnapshotOptions = {
  policy: CapturePolicy;
  trigger: A11ySnapshotTrigger;
  /** Triggers dropped by the per-minute cap since the previous snapshot. */
  droppedTriggers?: number;
  now?: () => number;
  maxWalkMs?: number;
};

type WalkContext = {
  policy: CapturePolicy;
  masking: A11ySnapshotMasking;
  /** The profile's redaction rules, without blocked selectors when one of them is invalid. */
  redaction: CapturePolicy["redaction"];
  focused: Element | null;
  now: () => number;
  deadline: number;
  visited: number;
  /** Children the time budget left unwalked (each may hide a subtree). */
  skipped: number;
  timedOut: boolean;
  /** Current DOM nesting of the walk, and the elements left out below `MAX_DOM_DEPTH`. */
  domDepth: number;
  tooDeep: number;
  frames: number;
};

type Rect = { left: number; top: number; right: number; bottom: number };

type WalkResult = { nodes: A11yTreeNode[]; inline?: string };

/** The snapshot payload of the current page, or null without a document body. */
export function captureA11ySnapshot(options: A11ySnapshotOptions): DomA11ySnapshotData | null {
  if (typeof document === "undefined" || !document.body) {
    return null;
  }

  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const redaction = options.policy.redaction;
  // Blocked selectors apply in every mode, like in the DOM snapshot. An invalid one fails closed:
  // no names, text or values at all.
  const selectorsValid = areValidSelectors(redaction.blockedSelectors);
  const context: WalkContext = {
    policy: options.policy,
    masking: selectorsValid ? resolveMasking(options.policy) : "wireframe",
    redaction: selectorsValid ? redaction : { ...redaction, blockedSelectors: [] },
    focused: document.activeElement,
    now,
    deadline: startedAt + (options.maxWalkMs ?? A11Y_SNAPSHOT_LIMITS.maxWalkMs),
    visited: 0,
    skipped: 0,
    timedOut: false,
    domDepth: 0,
    tooDeep: 0,
    frames: 0
  };
  const roots = walkDocumentBody(document.body, context, readViewportRect(window), 0);
  const formatted = formatA11yTree(roots, {
    omittedBefore: (context.timedOut ? Math.max(1, context.skipped) : 0) + context.tooDeep,
    cutReason: context.timedOut ? "time budget, elements not examined" : "depth budget"
  });

  return {
    trigger: options.trigger,
    url: clip(recordUrl(location.href, options.policy.redaction), A11Y_SNAPSHOT_LIMITS.maxUrlChars),
    ...(document.title && context.masking !== "wireframe"
      ? { title: clip(maskText(document.title, context), A11Y_SNAPSHOT_LIMITS.maxUrlChars) }
      : {}),
    viewport: {
      w: Math.round(window.innerWidth),
      h: Math.round(window.innerHeight),
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY)
    },
    scope: "viewport",
    tree: formatted.tree,
    nodeCount: formatted.nodeCount,
    omittedNodes: formatted.omittedNodes,
    truncated: formatted.truncated,
    masking: context.masking,
    ...(context.frames > 0 ? { frames: context.frames } : {}),
    ...(options.droppedTriggers ? { droppedTriggers: options.droppedTriggers } : {}),
    durationMs: Math.max(0, Math.round((now() - startedAt) * 10) / 10)
  };
}

function resolveMasking(policy: CapturePolicy): A11ySnapshotMasking {
  // `designMode` makes the whole page an editor without any attribute to find: its text is typed
  // input, which only the `allow` inputs level records.
  if (
    policy.categories.dom === "wireframe" ||
    (document.designMode === "on" && policy.categories.inputs !== "allow")
  ) {
    return "wireframe";
  }

  return isContentRedactionEnabled(policy.redaction) ? "masked" : "none";
}

function areValidSelectors(selectors: readonly string[]): boolean {
  const probe = document.createElement("div");

  return selectors.every((selector) => {
    try {
      probe.matches(selector);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * A blocked selector matches the element itself and no unmask selector re-allows it. Enough for
 * walked elements, whose ancestors were checked on the way down (in every shadow root and frame).
 */
function isBlockedHere(element: Element, context: WalkContext): boolean {
  const { redaction } = context;
  return (
    redaction.blockedSelectors.some((selector) => element.matches(selector)) &&
    isCoveredByBlockedSelector(element, redaction)
  );
}

/** A blocked selector covers the element or an ancestor: elements reached by id or label. */
function isBlockedAnywhere(element: Element, context: WalkContext): boolean {
  return (
    context.redaction.blockedSelectors.length > 0 &&
    isCoveredByBlockedSelector(element, context.redaction)
  );
}

function readViewportRect(view: Window): Rect {
  return { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
}

/** A document's body: the walk starts below it, so a selector blocking `body` or `html` is checked here. */
function walkDocumentBody(
  body: HTMLElement,
  context: WalkContext,
  viewport: Rect,
  depth: number
): A11yTreeNode[] {
  return isBlockedAnywhere(body, context)
    ? [{ role: "generic", states: ["masked"] }]
    : walkChildren(body, context, viewport, depth);
}

function walkChildren(
  parent: Element,
  context: WalkContext,
  viewport: Rect,
  depth: number
): A11yTreeNode[] {
  const nodes: A11yTreeNode[] = [];
  let text = "";
  const flushText = (): void => {
    const collapsed = collapseWhitespace(text);
    text = "";

    if (collapsed && context.masking !== "wireframe") {
      nodes.push({ role: "text", value: clip(maskText(collapsed, context)) });
    }
  };

  if (context.domDepth >= MAX_DOM_DEPTH) {
    context.tooDeep += parent.childElementCount;
    return nodes;
  }

  context.domDepth += 1;

  for (const child of listChildren(parent)) {
    if (context.timedOut) {
      context.skipped += 1;
      continue;
    }

    if (child.nodeType === Node.TEXT_NODE) {
      text += ` ${child.nodeValue ?? ""}`;
      continue;
    }

    if (!isElement(child)) {
      continue;
    }

    const result = walkElement(child, context, viewport, depth);

    if (result.inline !== undefined) {
      text += ` ${result.inline}`;
      continue;
    }

    if (result.nodes.length > 0) {
      flushText();
      nodes.push(...result.nodes);
    }
  }

  flushText();
  context.domDepth -= 1;
  return nodes;
}

/** Children as rendered: an open shadow root replaces the light DOM, slots their assigned nodes. */
function listChildren(parent: Element): Node[] {
  const source = parent.shadowRoot ? parent.shadowRoot.childNodes : parent.childNodes;
  const nodes: Node[] = [];

  for (const child of source) {
    if (isElement(child) && isTag(child, "SLOT")) {
      nodes.push(...(child as HTMLSlotElement).assignedNodes({ flatten: true }));
    } else {
      nodes.push(child);
    }
  }

  return nodes;
}

function walkElement(
  element: Element,
  context: WalkContext,
  viewport: Rect,
  depth: number
): WalkResult {
  context.visited += 1;

  if (context.visited % DEADLINE_CHECK_EVERY === 0 && context.now() > context.deadline) {
    context.timedOut = true;
    context.skipped += 1;
    return { nodes: [] };
  }

  if (
    SKIPPED_TAGS.has(element.tagName) ||
    element.hasAttribute(OWN_UI_ATTRIBUTE) ||
    isHidden(element) ||
    !intersects(element, viewport)
  ) {
    return { nodes: [] };
  }

  const role = resolveRole(element);

  if (role === "none") {
    return { nodes: [] };
  }

  if (isBlockedHere(element, context)) {
    return { nodes: [{ role: role ?? "generic", states: ["masked"] }] };
  }

  if (role === null) {
    // A generic container: its children take its place; plain text joins the parent's text.
    const children = walkChildren(element, context, viewport, depth);
    return isTextOnly(children)
      ? { nodes: [], inline: children[0]?.value ?? "" }
      : { nodes: children };
  }

  return { nodes: [buildRoleNode(element, role, context, viewport, depth)] };
}

function buildRoleNode(
  element: Element,
  role: string,
  context: WalkContext,
  viewport: Rect,
  depth: number
): A11yTreeNode {
  const node: A11yTreeNode = { role };
  const name = computeName(element, role, context);
  const states = readStates(element, role, context);
  const value = readValue(element, role, context);

  if (name && context.masking !== "wireframe") {
    node.name = clip(maskText(name, context));
  }

  if (states.length > 0) {
    node.states = states;
  }

  if (value !== undefined) {
    node.value = value;
  }

  if (role === "iframe") {
    return withFrameContent(node, element, context, depth);
  }

  if (
    NAME_FROM_CONTENT_ROLES.has(role) ||
    VALUE_ROLES.has(role) ||
    depth >= A11Y_SNAPSHOT_LIMITS.maxDepth
  ) {
    return node;
  }

  const children = walkChildren(element, context, viewport, depth + 1);

  if (isTextOnly(children) && node.value === undefined) {
    node.value = children[0]?.value;
  } else if (children.length > 0) {
    node.children = children;
  }

  return node;
}

function isTextOnly(children: readonly A11yTreeNode[]): boolean {
  return children.length === 1 && children[0]?.role === "text";
}

/** A same-origin frame's visible content under its `iframe` node; other frames stay a leaf. */
function withFrameContent(
  node: A11yTreeNode,
  frame: Element,
  context: WalkContext,
  depth: number
): A11yTreeNode {
  if (!isTag(frame, "IFRAME") || depth >= A11Y_SNAPSHOT_LIMITS.maxDepth) {
    return node;
  }

  let body: HTMLElement | null = null;
  let view: Window | null = null;

  try {
    body = (frame as HTMLIFrameElement).contentDocument?.body ?? null;
    view = (frame as HTMLIFrameElement).contentWindow;
  } catch {
    return node;
  }

  if (!body || !view) {
    return node;
  }

  context.frames += 1;
  const children = walkDocumentBody(body, context, readViewportRect(view), depth + 1);
  return children.length > 0 ? { ...node, children } : node;
}

/** Hidden from everyone: `hidden`, `aria-hidden`, `inert`, `display: none`, `visibility`. */
function isHidden(element: Element): boolean {
  if (
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden") ||
    element.hasAttribute("inert")
  ) {
    return true;
  }

  const candidate = element as Element & {
    checkVisibility?: (options?: Record<string, boolean>) => boolean;
  };

  if (typeof candidate.checkVisibility === "function") {
    return !candidate.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  }

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display === "none" || style?.visibility === "hidden";
}

/** Laid-out boxes wholly outside the viewport are skipped; boxes without a size are kept. */
function intersects(element: Element, viewport: Rect): boolean {
  const rect = element.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) {
    return true;
  }

  return (
    rect.right > viewport.left &&
    rect.left < viewport.right &&
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom
  );
}

/** The element's role; null for a generic container, `none` for presentation. */
function resolveRole(element: Element): string | null {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();

  if (explicit) {
    return explicit === "presentation" ? "none" : explicit;
  }

  const tag = element.tagName;

  if (HEADING_TAG_PATTERN.test(tag)) {
    return "heading";
  }

  if (tag === "A" || tag === "AREA") {
    return element.hasAttribute("href") ? "link" : null;
  }

  if (tag === "INPUT") {
    return resolveInputRole(element as HTMLInputElement);
  }

  if (tag === "SELECT") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }

  if (tag === "IMG") {
    return element.getAttribute("alt") === "" ? "none" : "img";
  }

  if (element.localName === "svg") {
    return element.hasAttribute("aria-label") || element.querySelector("title") ? "img" : "none";
  }

  if (tag === "HEADER" || tag === "FOOTER") {
    if (hasLandmarkScopeAncestor(element)) {
      return null;
    }

    return tag === "HEADER" ? "banner" : "contentinfo";
  }

  if (tag === "SECTION") {
    return element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")
      ? "region"
      : null;
  }

  if (isEditableRoot(element)) {
    return "textbox";
  }

  return TAG_ROLES[tag] ?? null;
}

/** An editable region; inside it only the region itself is a textbox. */
function isEditableRoot(element: Element): boolean {
  const html = element as HTMLElement;
  return html.isContentEditable === true && html.parentElement?.isContentEditable !== true;
}

function resolveInputRole(input: HTMLInputElement): string | null {
  const type = input.type.toLowerCase();

  if (type === "hidden") {
    return "none";
  }

  if (input.hasAttribute("list") && !(type in INPUT_TYPE_ROLES)) {
    return "combobox";
  }

  return INPUT_TYPE_ROLES[type] ?? "textbox";
}

function hasLandmarkScopeAncestor(element: Element): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (LANDMARK_SCOPE_TAGS.has(parent.tagName)) {
      return true;
    }
  }

  return false;
}

/** The accessible name, simplified accname: labelledby, label, native labels, content, title. */
function computeName(element: Element, role: string, context: WalkContext): string {
  const labelledBy = element.getAttribute("aria-labelledby");

  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => {
        const label = id ? element.ownerDocument.getElementById(id) : null;
        return label ? readVisibleText(label, context) : "";
      })
      .join(" ");
    const collapsed = collapseWhitespace(text);

    if (collapsed) {
      return collapsed;
    }
  }

  const label = collapseWhitespace(element.getAttribute("aria-label") ?? "");

  if (label) {
    return label;
  }

  const native = readNativeName(element, context);

  if (native) {
    return native;
  }

  if (NAME_FROM_CONTENT_ROLES.has(role)) {
    const content = collapseWhitespace(readVisibleText(element, context));

    if (content) {
      return content;
    }
  }

  return collapseWhitespace(element.getAttribute("title") ?? "");
}

function readNativeName(element: Element, context: WalkContext): string {
  if (isTag(element, "INPUT")) {
    const input = element as HTMLInputElement;
    const type = input.type.toLowerCase();

    if (type === "button" || type === "submit" || type === "reset") {
      return input.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
    }

    if (type === "image") {
      return collapseWhitespace(input.alt);
    }
  }

  if (isTag(element, "INPUT") || isTag(element, "TEXTAREA") || isTag(element, "SELECT")) {
    const field = element as HTMLInputElement;
    const fromLabels = collapseWhitespace(
      Array.from(field.labels ?? [], (label) => readVisibleText(label, context, element)).join(" ")
    );

    return fromLabels || collapseWhitespace(element.getAttribute("placeholder") ?? "");
  }

  if (isTag(element, "IMG")) {
    return collapseWhitespace((element as HTMLImageElement).alt);
  }

  const captionSelector = NATIVE_CAPTION_SELECTORS[element.localName];

  const caption = captionSelector ? element.querySelector(captionSelector) : null;

  if (caption) {
    return collapseWhitespace(readVisibleText(caption, context));
  }

  return "";
}

/** Child elements that name their parent. */
const NATIVE_CAPTION_SELECTORS: Readonly<Record<string, string>> = {
  fieldset: ":scope > legend",
  table: ":scope > caption",
  figure: ":scope > figcaption",
  svg: "title",
  details: ":scope > summary"
};

/**
 * Text of a subtree without hidden parts, scripts, blocked elements or `skip` (a labelled field
 * inside its label).
 */
function readVisibleText(root: Element, context: WalkContext, skip?: Element): string {
  if (isBlockedAnywhere(root, context)) {
    return "";
  }

  let text = "";
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        if (!isElement(node)) {
          return NodeFilter.FILTER_ACCEPT;
        }

        if (
          node === skip ||
          SKIPPED_TAGS.has(node.tagName) ||
          node.getAttribute("aria-hidden") === "true" ||
          node.hasAttribute("hidden") ||
          isBlockedHere(node, context)
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        const alt = isTag(node, "IMG") ? (node as HTMLImageElement).alt : "";

        if (alt) {
          text += ` ${alt}`;
        }

        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    text += ` ${node.nodeValue ?? ""}`;

    if (text.length > A11Y_SNAPSHOT_LIMITS.maxTextChars * 2) {
      break;
    }
  }

  return text;
}

function readStates(element: Element, role: string, context: WalkContext): string[] {
  const states: string[] = [];
  const level = readHeadingLevel(element, role);
  const checked = readChecked(element);
  const current = element.getAttribute("aria-current");

  if (level !== null) {
    states.push(`level=${level}`);
  }

  if (isFlagged(element, "disabled", "aria-disabled")) {
    states.push("disabled");
  }

  if (checked) {
    states.push(checked);
  }

  pushToggle(states, element.getAttribute("aria-pressed"), "pressed");
  pushExpanded(states, element);

  if (
    element.getAttribute("aria-selected") === "true" ||
    // A native option's selectedness is the user's pick: an input value.
    (isTag(element, "OPTION") &&
      context.policy.categories.inputs === "allow" &&
      (element as HTMLOptionElement).selected)
  ) {
    states.push("selected");
  }

  if (isFlagged(element, "required", "aria-required")) {
    states.push("required");
  }

  if (isInvalid(element)) {
    states.push("invalid");
  }

  if (isFlagged(element, "readOnly", "aria-readonly")) {
    states.push("readonly");
  }

  if (current && current !== "false") {
    states.push(current === "true" ? "current" : `current=${current}`);
  }

  if (element.getAttribute("aria-busy") === "true") {
    states.push("busy");
  }

  if (element === context.focused) {
    states.push("focused");
  }

  return states;
}

/** A native boolean property (`disabled`, `required`, `readOnly`) or its ARIA attribute. */
function isFlagged(element: Element, property: string, ariaAttribute: string): boolean {
  return (
    (element as unknown as Record<string, unknown>)[property] === true ||
    element.getAttribute(ariaAttribute) === "true"
  );
}

function readHeadingLevel(element: Element, role: string): number | null {
  if (role !== "heading") {
    return null;
  }

  const aria = Number.parseInt(element.getAttribute("aria-level") ?? "", 10);

  if (Number.isInteger(aria) && aria > 0) {
    return aria;
  }

  const match = HEADING_TAG_PATTERN.exec(element.tagName);
  return match ? Number(match[1]) : 2;
}

function readChecked(element: Element): string | null {
  const input = element as HTMLInputElement;

  if (isTag(element, "INPUT") && (input.type === "checkbox" || input.type === "radio")) {
    if (input.indeterminate) {
      return "checked=mixed";
    }

    return input.checked ? "checked" : null;
  }

  const aria = element.getAttribute("aria-checked");
  return aria === "true" ? "checked" : aria === "mixed" ? "checked=mixed" : null;
}

function pushToggle(states: string[], value: string | null, state: string): void {
  if (value === "true") {
    states.push(state);
  } else if (value === "mixed") {
    states.push(`${state}=mixed`);
  }
}

function pushExpanded(states: string[], element: Element): void {
  const aria = element.getAttribute("aria-expanded");
  const details = element.tagName === "SUMMARY" ? element.parentElement : null;
  let expanded: boolean | null = null;

  if (aria === "true" || aria === "false") {
    expanded = aria === "true";
  } else if (details && isTag(details, "DETAILS")) {
    expanded = (details as HTMLDetailsElement).open;
  }

  if (expanded !== null) {
    states.push(expanded ? "expanded" : "expanded=false");
  }
}

/** `aria-invalid`, or a native field the user left invalid (`:user-invalid`). */
function isInvalid(element: Element): boolean {
  const aria = element.getAttribute("aria-invalid");

  if (aria && aria !== "false") {
    return true;
  }

  try {
    return element.matches(":user-invalid");
  } catch {
    return false;
  }
}

/** Numeric widget values; typed field values only where the inputs policy allows them. */
function readValue(element: Element, role: string, context: WalkContext): string | undefined {
  const isRangeRole = role === "slider" || role === "progressbar" || role === "meter";

  if ((!isRangeRole && !VALUE_ROLES.has(role)) || context.masking === "wireframe") {
    return undefined;
  }

  // A range input is a field the user set; other range widgets show the page's own value.
  if (isTag(element, "INPUT") || isTag(element, "TEXTAREA")) {
    return readTypedValue(element as HTMLInputElement, context);
  }

  if (isRangeRole) {
    const text = element.getAttribute("aria-valuetext") ?? readNumericValue(element);
    return text ? clip(maskText(text, context)) : undefined;
  }

  // The option the user picked and the text typed into an editable region are input values.
  if (context.policy.categories.inputs !== "allow") {
    return undefined;
  }

  const shown = isTag(element, "SELECT")
    ? ((element as HTMLSelectElement).selectedOptions[0]?.textContent ?? "")
    : readVisibleText(element, context);
  const collapsed = collapseWhitespace(shown);
  return collapsed ? clip(maskText(collapsed, context)) : undefined;
}

function readNumericValue(element: Element): string | null {
  if (isTag(element, "PROGRESS") || isTag(element, "METER")) {
    return String((element as HTMLInputElement).value);
  }

  return element.getAttribute("aria-valuenow");
}

/**
 * A typed value where the inputs policy allows it. The policy checks run on the top document's
 * fields only: a frame's field belongs to another realm, where they cannot tell a password field,
 * so a frame keeps its values only when nothing is masked.
 */
function readTypedValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  context: WalkContext
): string | undefined {
  if (!field.value) {
    return undefined;
  }

  const recordsAll = context.masking === "none" && context.policy.categories.inputs === "allow";
  const value = recordsAll
    ? field.value
    : field.ownerDocument === document
      ? readCapturableInputValue(field, context.policy)
      : undefined;
  return value ? clip(maskText(value, context)) : undefined;
}

/** Realm-safe: elements of a same-origin frame are not `instanceof` this window's classes. */
function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isTag(element: Element, tagName: string): boolean {
  return element.tagName === tagName;
}

function maskText(text: string, context: WalkContext): string {
  if (context.masking === "none") {
    return text;
  }

  // The DOM snapshot's text rules: user value patterns, plus with the built-in heuristics URL
  // queries, credentials and secret-naming JSON.
  const rules = context.policy.redaction;
  return usesBuiltInHeuristics(rules)
    ? sanitizeVisibleText(text, rules, rules.redactBodyPatterns)
    : maskDomText(text, rules);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number = A11Y_SNAPSHOT_LIMITS.maxTextChars): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
