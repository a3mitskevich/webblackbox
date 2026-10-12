import type { DomTree, ReadonlyDomNode } from "./tree.js";

/**
 * A small CSS selector engine for the rebuilt DOM (no browser): type, `#id`, `.class`, attribute
 * selectors (`[a]`, `[a=v]`, `~=`, `^=`, `$=`, `*=`, `|=`, with an `i` flag), `*`, the descendant
 * and child combinators, and selector lists. Anything else is rejected with a clear error rather
 * than matched wrongly.
 */

type AttributeTest = {
  name: string;
  operator: "" | "=" | "~=" | "^=" | "$=" | "*=" | "|=";
  value: string;
  caseInsensitive: boolean;
};

type Compound = {
  tag: string | null;
  ids: string[];
  classes: string[];
  attributes: AttributeTest[];
};

/** Compounds right to left with the combinator that links each to the one on its left. */
type Complex = Array<{ compound: Compound; combinator: " " | ">" | null }>;

export class UnsupportedSelectorError extends Error {}

const MAX_SELECTOR_CHARS = 1_000;
const IDENT = /^-?[_a-zA-Z\u00a0-\uffff][_a-zA-Z0-9\u00a0-\uffff-]*|^\*/;
const NAME = /^[_a-zA-Z0-9\u00a0-\uffff-]+/;

function parseCompound(source: string, start: number): { compound: Compound; end: number } {
  const compound: Compound = { tag: null, ids: [], classes: [], attributes: [] };
  let index = start;
  const tag = IDENT.exec(source.slice(index));

  if (tag) {
    compound.tag = tag[0] === "*" ? null : tag[0].toLowerCase();
    index += tag[0].length;
  }

  while (index < source.length) {
    const char = source[index];

    if (char === "#" || char === ".") {
      const name = NAME.exec(source.slice(index + 1));

      if (!name) {
        throw new UnsupportedSelectorError(`Expected a name after "${char}" at ${index}.`);
      }

      (char === "#" ? compound.ids : compound.classes).push(name[0]);
      index += 1 + name[0].length;
      continue;
    }

    if (char === "[") {
      const close = source.indexOf("]", index);

      if (close < 0) {
        throw new UnsupportedSelectorError("Unclosed attribute selector.");
      }

      compound.attributes.push(parseAttribute(source.slice(index + 1, close)));
      index = close + 1;
      continue;
    }

    if (char === ":") {
      throw new UnsupportedSelectorError("Pseudo-classes are not supported.");
    }

    break;
  }

  if (index === start) {
    throw new UnsupportedSelectorError(`Unexpected "${source[start] ?? ""}" at ${start}.`);
  }

  return { compound, end: index };
}

function parseAttribute(body: string): AttributeTest {
  const match =
    /^\s*([_a-zA-Z0-9:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*(i)?)?\s*$/i.exec(
      body
    );

  if (!match) {
    throw new UnsupportedSelectorError(`Unsupported attribute selector [${body}].`);
  }

  return {
    name: match[1]!.toLowerCase(),
    operator: (match[2] ?? "") as AttributeTest["operator"],
    value: match[3] ?? match[4] ?? match[5] ?? "",
    caseInsensitive: match[6] !== undefined
  };
}

function parseComplex(source: string): Complex {
  const parts: Array<{ compound: Compound; combinator: " " | ">" | null }> = [];
  let index = 0;
  let combinator: " " | ">" | null = null;

  while (index < source.length) {
    const { compound, end } = parseCompound(source, index);
    parts.push({ compound, combinator });
    index = end;
    const rest = /^\s*(>)?\s*/.exec(source.slice(index))!;

    if (rest[0].length === 0 && index < source.length) {
      throw new UnsupportedSelectorError(
        `Unsupported syntax at ${index}: "${source.slice(index)}".`
      );
    }

    combinator = rest[1] ? ">" : " ";
    index += rest[0].length;
  }

  if (combinator === ">") {
    throw new UnsupportedSelectorError('A selector cannot end with ">".');
  }

  if (parts.length === 0) {
    throw new UnsupportedSelectorError("Empty selector.");
  }

  return parts.reverse();
}

/** Parses a selector list; throws {@link UnsupportedSelectorError} on anything it cannot match. */
export function parseSelector(selector: string): Complex[] {
  if (selector.length > MAX_SELECTOR_CHARS) {
    throw new UnsupportedSelectorError("Selector too long.");
  }

  if (/["']/.test(selector.replace(/\[[^\]]*\]/g, ""))) {
    throw new UnsupportedSelectorError("Quotes are only supported inside attribute selectors.");
  }

  return selector
    .split(/,(?![^[]*\])/)
    .map((part) => part.trim())
    .map((part) => {
      if (!part) {
        throw new UnsupportedSelectorError("Empty selector in the list.");
      }

      return parseComplex(part);
    });
}

function matchesAttribute(node: ReadonlyDomNode, test: AttributeTest): boolean {
  const actual = node.attributes[test.name];

  if (actual === undefined) {
    return false;
  }

  const value = test.caseInsensitive ? actual.toLowerCase() : actual;
  const expected = test.caseInsensitive ? test.value.toLowerCase() : test.value;

  switch (test.operator) {
    case "":
      return true;
    case "=":
      return value === expected;
    case "~=":
      return expected !== "" && !/\s/.test(expected) && value.split(/\s+/).includes(expected);
    case "^=":
      return expected !== "" && value.startsWith(expected);
    case "$=":
      return expected !== "" && value.endsWith(expected);
    case "*=":
      return expected !== "" && value.includes(expected);
    case "|=":
      return value === expected || value.startsWith(`${expected}-`);
  }
}

function matchesCompound(node: ReadonlyDomNode, compound: Compound): boolean {
  if (node.kind !== "element" || (compound.tag !== null && node.tagName !== compound.tag)) {
    return false;
  }

  const classes = (node.attributes.class ?? "").split(/\s+/);
  return (
    compound.ids.every((id) => node.attributes.id === id) &&
    compound.classes.every((name) => classes.includes(name)) &&
    compound.attributes.every((test) => matchesAttribute(node, test))
  );
}

function matchesComplex(tree: DomTree, node: ReadonlyDomNode, complex: Complex, at = 0): boolean {
  const part = complex[at];

  if (!part || !matchesCompound(node, part.compound)) {
    return false;
  }

  const next = complex[at + 1];

  if (!next) {
    return true;
  }

  // `part.combinator` links this compound to the next one (the one on its left in the source).
  if (part.combinator === ">") {
    const parent = node.parentId === null ? undefined : tree.get(node.parentId);
    return parent !== undefined && matchesComplex(tree, parent, complex, at + 1);
  }

  return tree
    .ancestors(node.id)
    .some((ancestor) => matchesComplex(tree, ancestor, complex, at + 1));
}

/** Element ids under `rootId` (itself included) matching the selector, in document order. */
export function querySelectorAll(
  tree: DomTree,
  rootId: number,
  selector: string,
  limit: number
): number[] {
  const selectors = parseSelector(selector);
  const matches: number[] = [];
  const stack = [rootId];

  while (stack.length > 0 && matches.length < limit) {
    const node = tree.get(stack.pop()!);

    if (!node) {
      continue;
    }

    if (selectors.some((complex) => matchesComplex(tree, node, complex))) {
      matches.push(node.id);
    }

    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]!);
    }
  }

  return matches;
}
