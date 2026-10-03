/**
 * The extension pages rebuild their DOM on every state change instead of patching it. This helper
 * carries keyboard focus over a rebuild so keyboard and screen-reader users keep their place.
 */

type FocusKey = {
  tag: string;
  attributes: ReadonlyArray<readonly [string, string]>;
  selection?: { start: number | null; end: number | null };
};

/** Attributes that identify a control across renders. */
const IDENTITY_ATTRIBUTES = new Set(["id", "name", "type", "value", "aria-label"]);

function isIdentityAttribute(name: string): boolean {
  return IDENTITY_ATTRIBUTES.has(name) || name.startsWith("data-");
}

function readFocusKey(element: HTMLElement): FocusKey {
  const attributes = Array.from(element.attributes)
    .filter((attribute) => isIdentityAttribute(attribute.name))
    .map((attribute) => [attribute.name, attribute.value] as const);
  const selection =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && (element.type === "text" || element.type === "search"))
      ? { start: element.selectionStart, end: element.selectionEnd }
      : undefined;

  return { tag: element.tagName, attributes, ...(selection ? { selection } : {}) };
}

function findByKey(container: HTMLElement, key: FocusKey): HTMLElement | null {
  const candidates = Array.from(container.getElementsByTagName(key.tag));
  const match = candidates.find((candidate) =>
    key.attributes.every(([name, value]) => candidate.getAttribute(name) === value)
  );

  return match instanceof HTMLElement ? match : null;
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
export function preserveFocus(container: HTMLElement, rerender: () => void): void {
  const doc = container.ownerDocument;
  const active = doc.activeElement;
  const key =
    active instanceof HTMLElement && active !== container && container.contains(active)
      ? readFocusKey(active)
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
