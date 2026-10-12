import { elementLabel, truncateText } from "./render.js";
import type { DomTree, DomNodeKind } from "./tree.js";

/**
 * What changed in the page between two moments: elements added and removed (top-most only),
 * attribute, text and field value changes. Both moments are copied compactly (`captureDomView`),
 * because the tree itself moves on.
 *
 * Nodes are matched by rrweb id. When rrweb restarted in between (a pressure-mode resume or a new
 * page: new ids) the ids no longer correspond, and elements are matched by their structural path
 * (`html/body/main[0]/div[2]`) instead — `matchedBy: "path"` says so.
 */

export type DomViewNode = {
  id: number;
  kind: DomNodeKind;
  tag: string;
  attributes: Readonly<Record<string, string>>;
  text: string;
  value?: string;
  checked?: boolean;
  parentId: number | null;
  children: readonly number[];
};

export type DomView = {
  rootId: number | null;
  nodes: ReadonlyMap<number, DomViewNode>;
};

export type DomNodeChange = {
  nodeId: number;
  path: string;
  label: string;
  text: string;
};

export type DomAttributeChange = {
  nodeId: number;
  path: string;
  changes: Array<{ name: string; before: string | null; after: string | null }>;
};

export type DomTextChange = { nodeId: number; path: string; before: string; after: string };

export type DomValueChange = {
  nodeId: number;
  path: string;
  before: string | null;
  after: string | null;
};

export type RrwebDomDiffResult = {
  matchedBy: "id" | "path";
  counts: { added: number; removed: number; attributes: number; texts: number; values: number };
  added: DomNodeChange[];
  removed: DomNodeChange[];
  attributes: DomAttributeChange[];
  texts: DomTextChange[];
  values: DomValueChange[];
  truncated: boolean;
};

export const DOM_DIFF_DEFAULT_ITEMS = 25;
const DIFF_TEXT_CHARS = 120;
/** Below this share of shared element ids the two moments are compared by path. */
const MIN_SHARED_ID_RATIO = 0.3;

/** A compact copy of the tree for comparison. */
export function captureDomView(tree: DomTree): DomView {
  const nodes = new Map<number, DomViewNode>();

  for (const id of tree.ids()) {
    const node = tree.get(id)!;
    nodes.set(id, {
      id,
      kind: node.kind,
      tag: node.tagName,
      attributes: { ...node.attributes },
      text: node.text,
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(node.checked !== undefined ? { checked: node.checked } : {}),
      parentId: node.parentId,
      children: [...node.children]
    });
  }

  return { rootId: tree.rootId, nodes };
}

function viewAncestors(view: DomView, id: number): DomViewNode[] {
  const chain: DomViewNode[] = [];
  let current = view.nodes.get(id);

  while (current && current.parentId !== null) {
    const parent = view.nodes.get(current.parentId);

    if (!parent) {
      break;
    }

    chain.push(parent);
    current = parent;
  }

  return chain;
}

function label(node: DomViewNode): string {
  return elementLabel({
    ...node,
    tagName: node.tag,
    isShadow: false
  });
}

function viewPath(view: DomView, id: number): string {
  const node = view.nodes.get(id);

  if (!node) {
    return "";
  }

  return [node, ...viewAncestors(view, id)]
    .filter((entry) => entry.kind === "element")
    .reverse()
    .map(label)
    .join(" > ");
}

function viewText(view: DomView, id: number, maxChars: number): string {
  const parts: string[] = [];
  const stack = [id];
  let length = 0;

  while (stack.length > 0 && length <= maxChars) {
    const node = view.nodes.get(stack.pop()!);

    if (!node || node.tag === "style" || node.tag === "script") {
      continue;
    }

    if (node.kind === "text") {
      parts.push(node.text);
      length += node.text.length;
      continue;
    }

    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }

  return truncateText(parts.join("").replace(/\s+/g, " ").trim(), maxChars);
}

/** Structural keys of the elements: `tag[index among element siblings]` from the root. */
function pathKeys(view: DomView): Map<string, number> {
  const keys = new Map<string, number>();

  if (view.rootId === null) {
    return keys;
  }

  const stack: Array<{ id: number; key: string }> = [{ id: view.rootId, key: "" }];

  while (stack.length > 0) {
    const { id, key } = stack.pop()!;
    const node = view.nodes.get(id);

    if (!node) {
      continue;
    }

    if (node.kind === "element") {
      keys.set(key, id);
    }

    let elementIndex = 0;

    for (const childId of node.children) {
      const child = view.nodes.get(childId);

      if (child?.kind === "element") {
        stack.push({ id: childId, key: `${key}/${child.tag}[${elementIndex}]` });
        elementIndex += 1;
      }
    }
  }

  return keys;
}

type Pairing = {
  matchedBy: "id" | "path";
  /** before id → after id for every element (and, by id, every node) in both. */
  pairs: Map<number, number>;
  onlyBefore: number[];
  onlyAfter: number[];
};

function pairNodes(before: DomView, after: DomView): Pairing {
  const elementIds = (view: DomView) =>
    Array.from(view.nodes.values()).filter((node) => node.kind === "element");
  const beforeElements = elementIds(before);
  const shared = beforeElements.filter((node) => after.nodes.has(node.id)).length;
  const ratio = beforeElements.length === 0 ? 1 : shared / beforeElements.length;

  if (ratio >= MIN_SHARED_ID_RATIO) {
    const pairs = new Map<number, number>();

    for (const id of before.nodes.keys()) {
      if (after.nodes.has(id)) {
        pairs.set(id, id);
      }
    }

    return {
      matchedBy: "id",
      pairs,
      onlyBefore: Array.from(before.nodes.keys()).filter((id) => !after.nodes.has(id)),
      onlyAfter: Array.from(after.nodes.keys()).filter((id) => !before.nodes.has(id))
    };
  }

  const beforeKeys = pathKeys(before);
  const afterKeys = pathKeys(after);
  const pairs = new Map<number, number>();

  for (const [key, id] of beforeKeys) {
    const match = afterKeys.get(key);

    if (match !== undefined) {
      pairs.set(id, match);
    }
  }

  return {
    matchedBy: "path",
    pairs,
    onlyBefore: Array.from(beforeKeys)
      .filter(([key]) => !afterKeys.has(key))
      .map(([, id]) => id),
    onlyAfter: Array.from(afterKeys)
      .filter(([key]) => !beforeKeys.has(key))
      .map(([, id]) => id)
  };
}

/** Of a set of nodes, the ones whose parent is not in the set (one entry per added subtree). */
function topMost(view: DomView, ids: readonly number[]): number[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const node = view.nodes.get(id);
    return node !== undefined && (node.parentId === null || !set.has(node.parentId));
  });
}

function nodeChange(view: DomView, id: number): DomNodeChange | null {
  const node = view.nodes.get(id);

  if (!node) {
    return null;
  }

  if (node.kind === "text") {
    const parent = node.parentId === null ? undefined : view.nodes.get(node.parentId);
    return {
      nodeId: id,
      path: parent ? viewPath(view, parent.id) : "",
      label: "#text",
      text: truncateText(node.text.replace(/\s+/g, " ").trim(), DIFF_TEXT_CHARS)
    };
  }

  return node.kind === "element"
    ? {
        nodeId: id,
        path: viewPath(view, id),
        label: label(node),
        text: viewText(view, id, DIFF_TEXT_CHARS)
      }
    : null;
}

function attributeChanges(before: DomViewNode, after: DomViewNode): DomAttributeChange["changes"] {
  const names = new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)]);
  return Array.from(names).flatMap((name) => {
    const old = before.attributes[name] ?? null;
    const next = after.attributes[name] ?? null;
    return old === next
      ? []
      : [
          {
            name,
            before: old === null ? null : truncateText(old, DIFF_TEXT_CHARS),
            after: next === null ? null : truncateText(next, DIFF_TEXT_CHARS)
          }
        ];
  });
}

function directText(view: DomView, node: DomViewNode): string {
  return node.children
    .map((id) => view.nodes.get(id))
    .filter((child) => child?.kind === "text")
    .map((child) => child!.text)
    .join("");
}

/** Compares two captured moments; each list is capped at `maxItems` (counts stay exact). */
export function diffDomViews(
  before: DomView,
  after: DomView,
  maxItems = DOM_DIFF_DEFAULT_ITEMS
): RrwebDomDiffResult {
  const pairing = pairNodes(before, after);
  const visible = (view: DomView, ids: readonly number[]) =>
    topMost(view, ids).filter((id) => {
      const kind = view.nodes.get(id)?.kind;
      return kind === "element" || (kind === "text" && view.nodes.get(id)!.text.trim() !== "");
    });
  const addedIds = visible(after, pairing.onlyAfter);
  const removedIds = visible(before, pairing.onlyBefore);
  const attributes: DomAttributeChange[] = [];
  const texts: DomTextChange[] = [];
  const values: DomValueChange[] = [];

  for (const [beforeId, afterId] of pairing.pairs) {
    const old = before.nodes.get(beforeId)!;
    const next = after.nodes.get(afterId)!;

    if (old.kind === "element" && next.kind === "element") {
      const changes = attributeChanges(old, next);

      if (changes.length > 0) {
        attributes.push({ nodeId: afterId, path: viewPath(after, afterId), changes });
      }

      if ((old.value ?? null) !== (next.value ?? null) || old.checked !== next.checked) {
        values.push({
          nodeId: afterId,
          path: viewPath(after, afterId),
          before: old.value ?? (old.checked === undefined ? null : String(old.checked)),
          after: next.value ?? (next.checked === undefined ? null : String(next.checked))
        });
      }

      // By path, text nodes have no stable identity: compare each element's own text.
      if (pairing.matchedBy === "path") {
        const oldText = directText(before, old).trim();
        const newText = directText(after, next).trim();

        if (oldText !== newText) {
          texts.push({
            nodeId: afterId,
            path: viewPath(after, afterId),
            before: truncateText(oldText, DIFF_TEXT_CHARS),
            after: truncateText(newText, DIFF_TEXT_CHARS)
          });
        }
      }
    } else if (old.kind === "text" && next.kind === "text" && old.text !== next.text) {
      texts.push({
        nodeId: afterId,
        path: next.parentId === null ? "" : viewPath(after, next.parentId),
        before: truncateText(old.text, DIFF_TEXT_CHARS),
        after: truncateText(next.text, DIFF_TEXT_CHARS)
      });
    }
  }

  const cap = <T>(items: readonly T[]) => items.slice(0, maxItems);
  const added = cap(addedIds).flatMap((id) => nodeChange(after, id) ?? []);
  const removed = cap(removedIds).flatMap((id) => nodeChange(before, id) ?? []);

  return {
    matchedBy: pairing.matchedBy,
    counts: {
      added: addedIds.length,
      removed: removedIds.length,
      attributes: attributes.length,
      texts: texts.length,
      values: values.length
    },
    added,
    removed,
    attributes: cap(attributes),
    texts: cap(texts),
    values: cap(values),
    truncated: [addedIds, removedIds, attributes, texts, values].some(
      (items) => items.length > maxItems
    )
  };
}
