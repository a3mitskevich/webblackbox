import type { Layout, LayoutStorage } from "react-resizable-panels";

/** Splitters exist only in the two-column layout; below this width the player is one column. */
export const WIDE_LAYOUT_QUERY = "(min-width: 901px)";

/** react-resizable-panels stores a layout under `react-resizable-panels:<id>`. */
const LIBRARY_STORAGE_PREFIX = "react-resizable-panels:";
const LAYOUT_ID_PREFIX = "webblackbox.player.layout.";

/** The storage id of a persisted split (`body`, `details`, or a feature's own name). */
export function layoutId(name: string): string {
  return `${LAYOUT_ID_PREFIX}${name}`;
}

/** Rail width before the user drags (PROPOSAL §5): 440 / 520 / 680 px by window width. */
export function defaultRailWidth(viewportWidth: number): number {
  if (viewportWidth >= 1800) {
    return 680;
  }

  return viewportWidth > 1280 ? 520 : 440;
}

export const RAIL_MIN_WIDTH_PX = 320;
export const STAGE_MIN_PERCENT = 30;
export const DETAILS_DEFAULT_PERCENT = 40;

/** The default stage/rail split of a group `groupWidth` px wide, in percent. */
export function defaultBodyLayout(groupWidth: number, viewportWidth: number): Layout {
  const width = Math.max(1, groupWidth);
  const rail = Math.min(
    100 - STAGE_MIN_PERCENT,
    Math.max((RAIL_MIN_WIDTH_PX / width) * 100, (defaultRailWidth(viewportWidth) / width) * 100)
  );

  return { "layout-stage": 100 - rail, "layout-rail": rail };
}

export function defaultDetailsLayout(detailsPercent: number = DETAILS_DEFAULT_PERCENT): Layout {
  return {
    "layout-list": 100 - detailsPercent,
    "layout-details": detailsPercent
  };
}

/** localStorage that never throws (private mode, blocked storage): sizes just are not kept. */
export const layoutStorage: LayoutStorage = {
  getItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Sizes are a convenience; a blocked storage keeps the defaults.
    }
  }
};

/** Drops every stored player split ("Reset layout"). */
export function clearStoredLayouts(storage: Pick<Storage, "length" | "key" | "removeItem">): void {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string =>
        key?.startsWith(`${LIBRARY_STORAGE_PREFIX}${LAYOUT_ID_PREFIX}`) ?? false
    );

    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // Nothing stored, or storage blocked.
  }
}
