import type { CaptureMode, CapturePolicy } from "@webblackbox/protocol";

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
 * Page-side raw events that full mode leaves out because CDP already records them
 * (DOM, scroll, screenshots and storage snapshots). Category rules can keep some of
 * them; see `isPageEventKeptInFullMode`. This is the single "what does full mode take
 * from the page" decision: the capture agent applies it at the source and every
 * consumer (extension service worker included) trusts what arrives.
 */
export const FULL_MODE_SKIPPED_RAW_TYPES: ReadonlySet<string> = new Set([
  "scroll",
  "mutation",
  "snapshot",
  "screenshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot"
]);

/**
 * Whether the page-side capture agent emits a raw event under the given mode. Lite mode
 * captures everything; full mode drops what CDP covers unless the profile asks for
 * something CDP does not record (storage details, or raw DOM and its changes). Any mode
 * other than `"full"` (including the agent's `"freeze"` indicator state) captures.
 */
export function shouldPageCapture(
  rawType: string,
  mode: CaptureMode | "freeze" | undefined,
  categories: Categories
): boolean {
  if (mode !== "full" || !FULL_MODE_SKIPPED_RAW_TYPES.has(rawType)) {
    return true;
  }

  return isPageEventKeptInFullMode(rawType, categories);
}

/**
 * Full mode captures the page through CDP and leaves page-side capture to lite, which keeps the
 * default output unchanged. Storage has no CDP event stream, so a profile that asks for more
 * than counts (key names, lengths or values, cookie or database names) gets the page-side
 * storage hooks and snapshots in full mode too.
 */
export function capturesPageStorageInFullMode(categories: Categories): boolean {
  return (
    ["names-only", "lengths-only", "allow"].includes(categories.storage) ||
    ["names-only", "allow"].includes(categories.indexedDb) ||
    ["names-only", "allow"].includes(categories.cookies)
  );
}

/** `dom: allow` records the page itself (masked by blocked selectors), not a summary. */
export function capturesRawDom(categories: Categories): boolean {
  return categories.dom === "allow";
}

/**
 * Whether a page-side raw event that full mode normally drops (CDP covers it) is kept because
 * the profile asks for something CDP does not record: storage details, or the raw DOM and how it
 * changes (mutation summaries; the agent re-snapshots the page after changes).
 */
export function isPageEventKeptInFullMode(rawType: string, categories: Categories): boolean {
  if (rawType === "snapshot" || rawType === "mutation") {
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
