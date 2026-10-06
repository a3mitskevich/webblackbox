import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";

/** Every category set: a profile always names each level, unlike older stored policies. */
export type CaptureCategories = Required<CapturePolicy["categories"]>;
export type CaptureCategoryKey = keyof CaptureCategories;

/**
 * Levels per capture category, least to most revealing. Shared by the profile editor matrix,
 * enterprise caps and the extended-capture check so they always agree on ordering.
 */
export const CAPTURE_CATEGORY_LEVELS: {
  readonly [TKey in CaptureCategoryKey]: readonly CaptureCategories[TKey][];
} = {
  actions: ["metadata", "masked", "allow"],
  inputs: ["none", "length-only", "masked", "allow"],
  dom: ["off", "wireframe", "masked", "allow"],
  screenshots: ["off", "masked", "allow"],
  screenRecordings: ["off", "allow"],
  console: ["off", "metadata", "sanitized", "allow"],
  network: ["metadata", "headers-allowlist", "body-allowlist"],
  storage: ["off", "counts-only", "names-only", "lengths-only", "allow"],
  indexedDb: ["off", "counts-only", "names-only", "allow"],
  cookies: ["off", "count-only", "names-only", "allow"],
  cdp: ["off", "safe-subset", "full"],
  heapProfiles: ["off", "lab-only"],
  tabsContext: ["off", "metadata", "allow"]
};

export const CAPTURE_CATEGORY_KEYS = Object.keys(CAPTURE_CATEGORY_LEVELS) as CaptureCategoryKey[];

// `names-only` and `lengths-only` reveal different things, so they share a rank.
const STORAGE_RANKS: Record<CaptureCategories["storage"], number> = {
  off: 0,
  "counts-only": 1,
  "names-only": 2,
  "lengths-only": 2,
  allow: 3
};

/** A policy's categories with the ones it predates (`tabsContext`) at their defaults. */
export function completeCaptureCategories(
  categories: CapturePolicy["categories"]
): CaptureCategories {
  return {
    ...categories,
    tabsContext:
      categories.tabsContext ?? DEFAULT_CAPTURE_POLICY.categories.tabsContext ?? "metadata"
  };
}

/** Numeric rank of a category level (higher = more data); -1 for unknown values. */
export function rankCategoryLevel<TKey extends CaptureCategoryKey>(
  key: TKey,
  value: CaptureCategories[TKey]
): number {
  if (key === "storage") {
    return STORAGE_RANKS[value as CaptureCategories["storage"]] ?? -1;
  }

  return (CAPTURE_CATEGORY_LEVELS[key] as readonly string[]).indexOf(value);
}

/** Category keys where `categories` reveals more than `ceiling`. */
export function findCategoriesAboveCeiling(
  categories: CaptureCategories,
  ceiling: CaptureCategories
): CaptureCategoryKey[] {
  return CAPTURE_CATEGORY_KEYS.filter(
    (key) => rankCategoryLevel(key, categories[key]) > rankCategoryLevel(key, ceiling[key])
  );
}
