/** Rows PageUp / PageDown move when the list is not laid out (hidden, jsdom). */
const FALLBACK_PAGE_ROWS = 10;

/**
 * Where a key moves the selection of a list or grid with `count` rows: ↑ / ↓ one row, PageUp /
 * PageDown a screen, Home / End the ends; `null` for any other key (the caller lets it through).
 * With nothing selected (`current < 0`) every move starts at the first row.
 */
export function nextListIndex(
  key: string,
  current: number,
  count: number,
  pageRows: number
): number | null {
  if (count === 0) {
    return null;
  }

  const last = count - 1;
  const from = Math.max(0, current);

  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(last, from + 1);
    case "ArrowUp":
      return current < 0 ? 0 : Math.max(0, from - 1);
    case "PageDown":
      return Math.min(last, from + pageRows);
    case "PageUp":
      return Math.max(0, from - pageRows);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * A key the list itself should handle: pressed on the list (not on a control inside it) and
 * without Ctrl / Alt / Meta, whose combinations stay with the browser.
 */
export function isOwnListKey(event: {
  target: EventTarget;
  currentTarget: EventTarget;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): boolean {
  return event.target === event.currentTarget && !event.ctrlKey && !event.altKey && !event.metaKey;
}

/** Rows that fit in the scroller's viewport (a PageUp / PageDown step). */
export function pageRowsOf(element: HTMLElement, rowHeight: number): number {
  const rows = Math.floor(element.clientHeight / rowHeight);
  return rows > 0 ? rows : FALLBACK_PAGE_ROWS;
}

/**
 * DOM id of row `index` of one list. Index-based under a per-instance prefix (`useId`), so two
 * rows never share an id whatever their data ids contain.
 */
export function rowDomId(prefix: string, index: number): string {
  return `${prefix}-row-${index}`;
}
