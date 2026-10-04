import type { CapturePolicy } from "@webblackbox/protocol";

/** Longest storage value kept on an op event or a snapshot entry. */
export const STORAGE_VALUE_MAX_CHARS = 2_048;

/** Most keys (or names) listed in one storage snapshot. */
export const STORAGE_SNAPSHOT_MAX_ITEMS = 300;

/** Most value characters across one localStorage snapshot; later values are left out. */
export const STORAGE_SNAPSHOT_MAX_VALUE_CHARS = 256 * 1024;

/** Page-side storage events: ops from the injected hooks and the agent's snapshots. */
const PAGE_STORAGE_RAW_TYPES = new Set([
  "localStorageOp",
  "sessionStorageOp",
  "indexedDbOp",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot"
]);

type Categories = CapturePolicy["categories"];

/**
 * Full mode captures the page through CDP and leaves page-side capture to lite, which keeps the
 * default output unchanged. Storage has no CDP event stream, so a profile that asks for more
 * than counts (key names, lengths or values, cookie or database names) gets the page-side
 * storage hooks and snapshots in full mode too.
 */
export function capturesPageStorageInFullMode(categories: Categories): boolean {
  return (
    ["names-only", "lengths-only", "allow"].includes(categories.storage) ||
    categories.indexedDb === "names-only" ||
    categories.cookies === "names-only"
  );
}

/** `dom: allow` records the page itself (masked by blocked selectors), not a summary. */
export function capturesRawDom(categories: Categories): boolean {
  return categories.dom === "allow";
}

/**
 * Whether a page-side raw event that full mode normally drops (CDP covers it) is kept because
 * the profile asks for something CDP does not record: storage details or the raw DOM.
 */
export function isPageEventKeptInFullMode(rawType: string, categories: Categories): boolean {
  if (rawType === "snapshot") {
    return capturesRawDom(categories);
  }

  return PAGE_STORAGE_RAW_TYPES.has(rawType) && capturesPageStorageInFullMode(categories);
}

/** A storage value as recorded: capped, with a flag when it was cut. */
export function capStorageValue(value: string): { value: string; valueTruncated?: true } {
  return value.length > STORAGE_VALUE_MAX_CHARS
    ? { value: value.slice(0, STORAGE_VALUE_MAX_CHARS), valueTruncated: true }
    : { value };
}
