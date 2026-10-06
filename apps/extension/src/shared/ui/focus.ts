/**
 * The extension pages rebuild their DOM on every state change instead of patching it. This helper
 * carries keyboard focus over a rebuild so keyboard and screen-reader users keep their place.
 */

type FocusKey = {
  tag: string;
  attributes: ReadonlyArray<readonly [string, string]>;
  /** Closest ancestor carrying one of the scope attributes, e.g. the rule row. */
  scope?: readonly [string, string];
  selection?: { start: number | null; end: number | null };
};

export type PreserveFocusOptions = {
  /**
   * Attributes of rows that tell equal controls apart (`data-rule-id`): focus goes back to the
   * control in the same row, wherever the row moved to.
   */
  scopeAttributes?: readonly string[];
};

/** Attributes that identify a control across renders. */
const IDENTITY_ATTRIBUTES = new Set(["id", "name", "type", "value", "aria-label"]);

function isIdentityAttribute(name: string): boolean {
  return IDENTITY_ATTRIBUTES.has(name) || name.startsWith("data-");
}

function readScope(
  element: HTMLElement,
  scopeAttributes: readonly string[]
): readonly [string, string] | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const name = scopeAttributes.find((attribute) => node?.hasAttribute(attribute));

    if (name) {
      return [name, node.getAttribute(name) ?? ""];
    }
  }

  return undefined;
}

function readFocusKey(element: HTMLElement, scopeAttributes: readonly string[]): FocusKey {
  const scope = readScope(element, scopeAttributes);
  const attributes = Array.from(element.attributes)
    .filter((attribute) => isIdentityAttribute(attribute.name))
    // Row attributes (an index) change when the row moves; the scope identifies the row.
    .filter((attribute) => !scope || !attribute.name.endsWith("-index"))
    .map((attribute) => [attribute.name, attribute.value] as const);
  const selection =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && (element.type === "text" || element.type === "search"))
      ? { start: element.selectionStart, end: element.selectionEnd }
      : undefined;

  return {
    tag: element.tagName,
    attributes,
    ...(scope ? { scope } : {}),
    ...(selection ? { selection } : {})
  };
}

function findScope(container: HTMLElement, key: FocusKey): Element | null {
  if (!key.scope) {
    return container;
  }

  const [name, value] = key.scope;
  return (
    Array.from(container.querySelectorAll(`[${name}]`)).find(
      (candidate) => candidate.getAttribute(name) === value
    ) ?? null
  );
}

function isFocusable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && !(element as HTMLButtonElement).disabled;
}

function findByKey(container: HTMLElement, key: FocusKey): HTMLElement | null {
  const scope = findScope(container, key);

  if (!scope) {
    return null;
  }

  const match = Array.from(scope.getElementsByTagName(key.tag)).find((candidate) =>
    key.attributes.every(([name, value]) => candidate.getAttribute(name) === value)
  );

  if (match && isFocusable(match)) {
    return match;
  }

  // "Move up" is disabled once the row reaches the top: stay in the row on its next control.
  return key.scope
    ? (Array.from(scope.querySelectorAll("button, input, select, textarea")).find(isFocusable) ??
        null)
    : null;
}

function restoreSelection(element: HTMLElement, key: FocusKey): void {
  const start = key.selection?.start;

  if (
    typeof start !== "number" ||
    !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  ) {
    return;
  }

  try {
    element.setSelectionRange(start, key.selection?.end ?? start);
  } catch {
    // Input types without a selection API keep the default caret.
  }
}

/**
 * Runs `rerender` and moves focus back to the equivalent control in the new DOM when focus was
 * inside `container` before and got lost. Nothing happens when that control no longer exists.
 */
export function preserveFocus(
  container: HTMLElement,
  rerender: () => void,
  options: PreserveFocusOptions = {}
): void {
  const doc = container.ownerDocument;
  const active = doc.activeElement;
  const key =
    active instanceof HTMLElement && active !== container && container.contains(active)
      ? readFocusKey(active, options.scopeAttributes ?? [])
      : null;

  rerender();

  if (!key || (doc.activeElement && doc.activeElement !== doc.body)) {
    return;
  }

  const next = findByKey(container, key);

  if (next) {
    next.focus({ preventScroll: true });
    restoreSelection(next, key);
  }
}
