import {
  asSerializedNode,
  isNodeId,
  readMutationData,
  SERIALIZED_NODE_TYPES,
  type MutationAdd,
  type SerializedNode
} from "./serialized.js";

/**
 * The page's DOM rebuilt from rrweb's log without a browser (Node and browser alike): a full
 * snapshot, then mutations and field values applied in order. Nodes keep rrweb's ids, so a click or
 * an input event points straight at its element.
 *
 * The tree is mutable for speed (a mutation touches a few nodes of tens of thousands); callers get
 * read-only views and copy what they keep (see `diff.ts`).
 */

export type DomNodeKind = "document" | "doctype" | "element" | "text" | "cdata" | "comment";

export type DomNode = {
  readonly id: number;
  readonly kind: DomNodeKind;
  /** Lower-case tag name of an element, "" otherwise. */
  readonly tagName: string;
  attributes: Record<string, string>;
  /** Text of a text, comment or CDATA node; the name of a doctype. */
  text: string;
  parentId: number | null;
  children: number[];
  /** A child of a shadow root (rrweb records shadow DOM inline, under the host). */
  readonly isShadow: boolean;
  /** Live value / checked state of a field from rrweb input events. */
  value?: string;
  checked?: boolean;
};

export type ReadonlyDomNode = Readonly<Omit<DomNode, "attributes" | "children">> & {
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly number[];
};

/** A tree never holds more nodes than this; further adds are counted as dropped. */
export const DOM_TREE_MAX_NODES = 250_000;
/** Deeper subtrees are dropped (forged archives must not overflow the stack). */
export const DOM_TREE_MAX_DEPTH = 1_000;
/** Text kept per text node; longer text (inlined data, huge JSON) is cut. */
export const DOM_TREE_MAX_TEXT_CHARS = 100_000;

const KIND_BY_TYPE: Readonly<Record<number, DomNodeKind>> = {
  [SERIALIZED_NODE_TYPES.document]: "document",
  [SERIALIZED_NODE_TYPES.documentType]: "doctype",
  [SERIALIZED_NODE_TYPES.element]: "element",
  [SERIALIZED_NODE_TYPES.text]: "text",
  [SERIALIZED_NODE_TYPES.cdata]: "cdata",
  [SERIALIZED_NODE_TYPES.comment]: "comment"
};

/** An attribute value as the DOM would hold it (`true` → "", nothing for false/null). */
function attributeString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return value === true ? "" : null;
}

function readAttributes(value: unknown): Record<string, string> {
  const record = value !== null && typeof value === "object" ? value : {};
  const entries = Object.entries(record).flatMap(([name, raw]): Array<[string, string]> => {
    const text = attributeString(raw);
    return text === null ? [] : [[name.toLowerCase(), text]];
  });
  return Object.fromEntries(entries);
}

/**
 * A `style` change as rrweb records it (`{ property: value | [value, priority] | false }`) applied
 * to the element's style attribute.
 */
export function applyStyleChanges(current: string, changes: Record<string, unknown>): string {
  const declarations = new Map<string, string>();

  for (const part of current.split(";")) {
    const colon = part.indexOf(":");

    if (colon > 0) {
      declarations.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
    }
  }

  for (const [property, change] of Object.entries(changes)) {
    const name = property.trim().toLowerCase();

    if (change === false || change === null) {
      declarations.delete(name);
    } else if (typeof change === "string") {
      declarations.set(name, change);
    } else if (Array.isArray(change) && typeof change[0] === "string") {
      const priority = typeof change[1] === "string" && change[1] ? ` !${change[1]}` : "";
      declarations.set(name, `${change[0]}${priority}`);
    }
  }

  return Array.from(declarations, ([name, value]) => `${name}: ${value}`).join("; ");
}

export type MutationStats = { applied: number; skipped: number };

export class DomTree {
  private readonly nodes = new Map<number, DomNode>();
  private rootNodeId: number | null = null;
  private droppedNodes = 0;

  /** Builds the tree of one full snapshot (`data.node` of an rrweb `FullSnapshot` event). */
  public static fromSnapshot(node: unknown): DomTree {
    const tree = new DomTree();
    const root = asSerializedNode(node);

    if (root) {
      tree.rootNodeId = tree.insertSubtree(root, null);
    }

    return tree;
  }

  public get rootId(): number | null {
    return this.rootNodeId;
  }

  public get size(): number {
    return this.nodes.size;
  }

  /** Nodes left out because the tree was full or their parent was unknown. */
  public get dropped(): number {
    return this.droppedNodes;
  }

  public get(id: number): ReadonlyDomNode | undefined {
    return this.nodes.get(id);
  }

  public has(id: number): boolean {
    return this.nodes.has(id);
  }

  /** Every node id, in insertion order. */
  public ids(): IterableIterator<number> {
    return this.nodes.keys();
  }

  /** The element ancestors of a node, nearest first. */
  public ancestors(id: number): ReadonlyDomNode[] {
    const chain: ReadonlyDomNode[] = [];
    let current = this.nodes.get(id);

    while (current && current.parentId !== null) {
      const parent = this.nodes.get(current.parentId);

      if (!parent) {
        break;
      }

      chain.push(parent);
      current = parent;
    }

    return chain;
  }

  /** Applies an rrweb mutation (removes, adds, texts, attributes — rrweb's own order). */
  public applyMutation(data: unknown): MutationStats {
    const mutation = readMutationData(data);
    let applied = 0;
    let skipped = 0;

    for (const remove of mutation.removes) {
      if (this.nodes.has(remove.id)) {
        this.removeSubtree(remove.id);
        applied += 1;
      } else {
        skipped += 1;
      }
    }

    const added = this.applyAdds(mutation.adds);
    applied += added;
    skipped += mutation.adds.length - added;

    for (const text of mutation.texts) {
      const node = this.nodes.get(text.id);

      if (node && node.kind !== "element") {
        node.text = (text.value ?? "").slice(0, DOM_TREE_MAX_TEXT_CHARS);
        applied += 1;
      } else {
        skipped += 1;
      }
    }

    for (const change of mutation.attributes) {
      const node = this.nodes.get(change.id);

      if (!node || node.kind !== "element") {
        skipped += 1;
        continue;
      }

      node.attributes = this.applyAttributeChanges(node.attributes, change.attributes);
      applied += 1;
    }

    return { applied, skipped };
  }

  /** Applies an rrweb input event (`IncrementalSource.Input`): a field's live value. */
  public applyInput(data: unknown): boolean {
    const record =
      data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const node = isNodeId(record.id) ? this.nodes.get(record.id) : undefined;

    if (!node || node.kind !== "element") {
      return false;
    }

    if (typeof record.text === "string") {
      node.value = record.text.slice(0, DOM_TREE_MAX_TEXT_CHARS);
    }

    if (typeof record.isChecked === "boolean") {
      node.checked = record.isChecked;
    }

    return true;
  }

  private applyAttributeChanges(
    current: Record<string, string>,
    changes: Record<string, unknown>
  ): Record<string, string> {
    const next = { ...current };

    for (const [rawName, value] of Object.entries(changes)) {
      const name = rawName.toLowerCase();

      if (name === "style" && value !== null && typeof value === "object") {
        next.style = applyStyleChanges(next.style ?? "", value as Record<string, unknown>);
        continue;
      }

      const text = attributeString(value);

      if (text === null) {
        delete next[name];
      } else {
        next[name] = text;
      }
    }

    return next;
  }

  /**
   * Adds in rrweb's replay order: a node waits until its parent (and the sibling it goes before)
   * exists; what still waits when nothing moves goes last into its parent, or is dropped.
   */
  private applyAdds(adds: readonly MutationAdd[]): number {
    let pending = [...adds];
    let applied = 0;
    let progressed = true;

    while (pending.length > 0 && progressed) {
      progressed = false;
      const waiting: MutationAdd[] = [];

      for (const add of pending) {
        const nextMissing = add.nextId !== null && !this.nodes.has(add.nextId);

        if (!this.nodes.has(add.parentId) || nextMissing) {
          waiting.push(add);
          continue;
        }

        this.addNode(add);
        applied += 1;
        progressed = true;
      }

      pending = waiting;
    }

    for (const add of pending) {
      if (this.nodes.has(add.parentId)) {
        this.addNode({ ...add, nextId: null });
        applied += 1;
      } else {
        this.droppedNodes += 1;
      }
    }

    return applied;
  }

  private addNode(add: MutationAdd): void {
    // A moved node is recorded as an add of an id that still exists.
    if (this.nodes.has(add.node.id)) {
      this.removeSubtree(add.node.id);
    }

    const parent = this.nodes.get(add.parentId);

    if (!parent) {
      return;
    }

    const id = this.insertSubtree(add.node, add.parentId);

    if (id === null) {
      return;
    }

    const siblings = parent.children.filter((child) => child !== id);
    const nextIndex = add.nextId === null ? -1 : siblings.indexOf(add.nextId);
    const previousIndex = add.previousId === null ? -1 : siblings.indexOf(add.previousId);
    const at =
      nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : siblings.length;
    parent.children = [...siblings.slice(0, at), id, ...siblings.slice(at)];
  }

  /**
   * Inserts a serialized subtree, appended to its parent's children (callers place it); its id, or
   * null when the node is unknown or the tree is full.
   */
  private insertSubtree(node: SerializedNode, parentId: number | null, depth = 0): number | null {
    const kind = KIND_BY_TYPE[node.type];

    if (!kind || this.nodes.size >= DOM_TREE_MAX_NODES || depth > DOM_TREE_MAX_DEPTH) {
      this.droppedNodes += 1;
      return null;
    }

    const isElement = kind === "element";
    const entry: DomNode = {
      id: node.id,
      kind,
      tagName: isElement && typeof node.tagName === "string" ? node.tagName.toLowerCase() : "",
      attributes: isElement ? readAttributes(node.attributes) : {},
      text:
        kind === "doctype"
          ? typeof node.name === "string"
            ? node.name
            : "html"
          : typeof node.textContent === "string"
            ? node.textContent.slice(0, DOM_TREE_MAX_TEXT_CHARS)
            : "",
      parentId,
      children: [],
      isShadow: node.isShadow === true
    };
    this.nodes.set(entry.id, entry);

    // Children are appended in place: a snapshot of a wide table would copy the list per row.
    this.nodes.get(parentId ?? Number.NaN)?.children.push(entry.id);

    for (const child of node.childNodes ?? []) {
      const serialized = asSerializedNode(child);

      // An id already in the tree would corrupt it (forged or broken data): skipped.
      if (serialized && !this.nodes.has(serialized.id)) {
        this.insertSubtree(serialized, entry.id, depth + 1);
      }
    }

    return entry.id;
  }

  private removeSubtree(id: number): void {
    const node = this.nodes.get(id);

    if (!node) {
      return;
    }

    if (node.parentId !== null) {
      const parent = this.nodes.get(node.parentId);

      if (parent) {
        parent.children = parent.children.filter((child) => child !== id);
      }
    }

    const stack = [id];

    while (stack.length > 0) {
      const current = this.nodes.get(stack.pop()!);

      if (current) {
        this.nodes.delete(current.id);
        stack.push(...current.children);
      }
    }

    if (this.rootNodeId === id) {
      this.rootNodeId = null;
    }
  }
}
