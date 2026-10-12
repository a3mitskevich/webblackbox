import type { DomTree, ReadonlyDomNode } from "./tree.js";

/**
 * Compact views of a rebuilt DOM for analysis (MCP tools): HTML or an indented outline of a
 * subtree, within a depth and a byte budget. Every element carries its rrweb node id (`wb-id`), so a
 * caller can drill into anything that was cut.
 */

export type DomRenderFormat = "html" | "outline";

export type DomRenderOptions = {
  format?: DomRenderFormat;
  /** Levels below the root that are expanded; deeper children are summarized. */
  depth?: number;
  /** Budget for the rendered text in UTF-8 bytes; the rendering stops and says where. */
  maxBytes?: number;
  /** Text per text node / attribute value. */
  maxTextChars?: number;
  /** Collapse `<head>` to a one-line summary (title, stylesheet count). */
  collapseHead?: boolean;
};

export type DomRenderResult = {
  content: string;
  bytes: number;
  truncated: boolean;
  /** Elements cut by the depth limit or the budget: drill down with their ids. */
  omittedNodeIds: number[];
  renderedElements: number;
};

export const DOM_RENDER_DEFAULT_DEPTH = 12;
export const DOM_RENDER_DEFAULT_MAX_BYTES = 24_000;
export const DOM_RENDER_DEFAULT_TEXT_CHARS = 160;
const ATTRIBUTE_MAX_CHARS = 120;
const OMITTED_IDS_MAX = 40;
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);
/** Elements whose text is code or style, summarized instead of shown. */
const OPAQUE_TEXT_ELEMENTS = new Set(["style", "script", "noscript", "template"]);
/** rrweb's inlined stylesheet text: summarized, it can be megabytes. */
const INLINED_CSS_ATTRIBUTE = "_csstext";

/** UTF-8 length of a string without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}

export function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** `tag#id.class1.class2` of an element (classes capped). */
export function elementLabel(node: ReadonlyDomNode): string {
  if (node.kind !== "element") {
    return node.kind === "document" ? "#document" : `#${node.kind}`;
  }

  const id = node.attributes.id ? `#${node.attributes.id}` : "";
  const classes = (node.attributes.class ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join("");
  return `${node.tagName}${id}${classes}`;
}

/** `html > body > main#app > button.act` from the root down to the node. */
export function elementPath(tree: DomTree, id: number): string {
  const node = tree.get(id);

  if (!node) {
    return "";
  }

  const chain = [node, ...tree.ancestors(id)].filter((entry) => entry.kind === "element");
  return chain
    .reverse()
    .map((entry) => elementLabel(entry))
    .join(" > ");
}

/** The text of a subtree (as `textContent` reads it, whitespace collapsed), capped. */
export function textContentOf(tree: DomTree, id: number, maxChars: number): string {
  const parts: string[] = [];
  let length = 0;
  const stack = [id];

  while (stack.length > 0 && length <= maxChars) {
    const node = tree.get(stack.pop()!);

    if (!node || OPAQUE_TEXT_ELEMENTS.has(node.tagName)) {
      continue;
    }

    if (node.kind === "text" || node.kind === "cdata") {
      parts.push(node.text);
      length += node.text.length;
      continue;
    }

    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }

  return truncateText(collapseWhitespace(parts.join("")).trim(), maxChars);
}

/** Attribute values as shown: capped, inlined CSS summarized, live field state added. */
export function displayAttributes(node: ReadonlyDomNode): Array<[string, string]> {
  const entries = Object.entries(node.attributes).map(([name, value]): [string, string] =>
    name === INLINED_CSS_ATTRIBUTE
      ? [name, `[${value.length} chars of inlined CSS]`]
      : [name, truncateText(value, ATTRIBUTE_MAX_CHARS)]
  );
  const live: Array<[string, string]> = [
    ...(node.value !== undefined
      ? [["wb-value", truncateText(node.value, ATTRIBUTE_MAX_CHARS)]]
      : []),
    ...(node.checked !== undefined ? [["wb-checked", String(node.checked)]] : [])
  ] as Array<[string, string]>;
  return [...entries, ...live];
}

type RenderContext = {
  tree: DomTree;
  format: DomRenderFormat;
  depth: number;
  maxBytes: number;
  maxTextChars: number;
  collapseHead: boolean;
  out: string[];
  bytes: number;
  truncated: boolean;
  omitted: number[];
  rendered: number;
};

function write(context: RenderContext, text: string): boolean {
  const size = utf8Length(text);

  if (context.bytes + size > context.maxBytes) {
    context.truncated = true;
    return false;
  }

  context.out.push(text);
  context.bytes += size;
  return true;
}

function omit(context: RenderContext, id: number): void {
  if (context.omitted.length < OMITTED_IDS_MAX) {
    context.omitted.push(id);
  }
}

function elementChildren(tree: DomTree, node: ReadonlyDomNode): ReadonlyDomNode[] {
  return node.children.flatMap((id) => {
    const child = tree.get(id);
    return child && child.kind === "element" ? [child] : [];
  });
}

function headSummary(tree: DomTree, head: ReadonlyDomNode): string {
  const children = elementChildren(tree, head);
  const title = children.find((child) => child.tagName === "title");
  const stylesheets = children.filter(
    (child) =>
      child.tagName === "style" ||
      (child.tagName === "link" && /stylesheet/i.test(child.attributes.rel ?? ""))
  ).length;
  const titleText = title ? textContentOf(tree, title.id, 120) : "";
  return `${children.length} elements${titleText ? `, title "${titleText}"` : ""}, ${stylesheets} stylesheets`;
}

function renderHtmlNode(context: RenderContext, id: number, level: number): boolean {
  const { tree } = context;
  const node = tree.get(id);

  if (!node) {
    return true;
  }

  switch (node.kind) {
    case "text":
    case "cdata": {
      const text = collapseWhitespace(node.text);
      return text.trim() === ""
        ? true
        : write(context, escapeHtmlText(truncateText(text, context.maxTextChars)));
    }
    case "comment":
      return true;
    case "doctype":
      return write(context, `<!DOCTYPE ${node.text}>`);
    case "document":
      return node.children.every((child) => renderHtmlNode(context, child, level));
    case "element":
      break;
  }

  const shown: Array<[string, string]> = [["wb-id", String(node.id)], ...displayAttributes(node)];
  const attributes = shown
    .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`))
    .join("");
  const shadow = node.isShadow ? " wb-shadow" : "";

  if (!write(context, `<${node.tagName}${attributes}${shadow}>`)) {
    omit(context, node.id);
    return false;
  }

  context.rendered += 1;

  if (VOID_ELEMENTS.has(node.tagName)) {
    return true;
  }

  const close = `</${node.tagName}>`;
  // The closing tag is always written: the budget keeps room for the open ones.
  context.maxBytes -= utf8Length(close);
  let complete = true;

  if (OPAQUE_TEXT_ELEMENTS.has(node.tagName)) {
    const length = node.children.reduce(
      (sum, child) => sum + (tree.get(child)?.text.length ?? 0),
      0
    );
    complete = length === 0 || write(context, `/* ${length} chars */`);
  } else if (context.collapseHead && node.tagName === "head") {
    complete = write(context, `<!-- ${headSummary(tree, node)}; nodeId=${node.id} -->`);
  } else if (level >= context.depth && node.children.length > 0) {
    const elements = elementChildren(tree, node).length;
    const text = textContentOf(tree, node.id, context.maxTextChars);
    omit(context, node.id);
    complete = write(
      context,
      `<!-- ${elements} child elements${text ? `, text "${text}"` : ""}; nodeId=${node.id} -->`
    );
  } else {
    for (const child of node.children) {
      if (!renderHtmlNode(context, child, level + 1)) {
        complete = false;
        const remaining = node.children.slice(node.children.indexOf(child) + 1);
        remaining.forEach((rest) => {
          if (tree.get(rest)?.kind === "element") {
            omit(context, rest);
          }
        });
        break;
      }
    }
  }

  context.maxBytes += utf8Length(close);
  context.out.push(close);
  context.bytes += utf8Length(close);
  return complete;
}

function renderOutlineNode(context: RenderContext, id: number, level: number): boolean {
  const { tree } = context;
  const node = tree.get(id);

  if (!node) {
    return true;
  }

  if (node.kind === "document") {
    return elementChildren(tree, node).every((child) =>
      renderOutlineNode(context, child.id, level)
    );
  }

  if (node.kind !== "element") {
    return true;
  }

  const children = elementChildren(tree, node);
  const ownText = node.children
    .map((child) => tree.get(child))
    .filter((child) => child?.kind === "text")
    .map((child) => child!.text)
    .join("");
  const text =
    children.length === 0 || level >= context.depth
      ? textContentOf(tree, node.id, context.maxTextChars)
      : truncateText(collapseWhitespace(ownText).trim(), context.maxTextChars);
  const state = [
    node.value !== undefined ? ` value="${truncateText(node.value, ATTRIBUTE_MAX_CHARS)}"` : "",
    node.checked !== undefined ? ` checked=${node.checked}` : ""
  ].join("");
  const cut = level >= context.depth && children.length > 0;
  const line = `${"  ".repeat(level)}${elementLabel(node)} [${node.id}]${state}${
    text ? ` "${text}"` : ""
  }${cut ? ` (+${children.length} children)` : ""}\n`;

  if (!write(context, line)) {
    omit(context, node.id);
    return false;
  }

  context.rendered += 1;

  if (cut) {
    omit(context, node.id);
    return true;
  }

  if (context.collapseHead && node.tagName === "head") {
    return true;
  }

  for (const [index, child] of children.entries()) {
    if (!renderOutlineNode(context, child.id, level + 1)) {
      children.slice(index + 1).forEach((rest) => omit(context, rest.id));
      return false;
    }
  }

  return true;
}

/** Renders the subtree under `rootId` within the options' budgets. */
export function renderDomSubtree(
  tree: DomTree,
  rootId: number,
  options: DomRenderOptions = {}
): DomRenderResult {
  const context: RenderContext = {
    tree,
    format: options.format ?? "html",
    depth: Math.max(0, options.depth ?? DOM_RENDER_DEFAULT_DEPTH),
    maxBytes: Math.max(256, options.maxBytes ?? DOM_RENDER_DEFAULT_MAX_BYTES),
    maxTextChars: Math.max(16, options.maxTextChars ?? DOM_RENDER_DEFAULT_TEXT_CHARS),
    collapseHead: options.collapseHead ?? true,
    out: [],
    bytes: 0,
    truncated: false,
    omitted: [],
    rendered: 0
  };

  if (context.format === "outline") {
    renderOutlineNode(context, rootId, 0);
  } else {
    renderHtmlNode(context, rootId, 0);
  }

  return {
    content: context.out.join(""),
    bytes: context.bytes,
    truncated: context.truncated,
    omittedNodeIds: context.omitted,
    renderedElements: context.rendered
  };
}
