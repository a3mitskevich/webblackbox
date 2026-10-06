/**
 * Whether Start asks to reload the page first ("Start with page reload" / "Start without
 * reload"), in both engines. A popup preference under its own storage key: it is not a recorder
 * setting, so it stays out of the recording profiles.
 */

export const START_RELOAD_OFFER_STORAGE_KEY = "webblackbox.startReloadOffer";
export const DEFAULT_START_RELOAD_OFFER = true;

type StorageAreaLike = {
  get(keys?: string[] | string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
};

/** Only a stored boolean counts; installs that never stored the flag get the default. */
export function normalizeStartReloadOffer(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_START_RELOAD_OFFER;
}

/** Never throws: unavailable or failing storage reads as the default. */
export async function loadStartReloadOffer(storage: StorageAreaLike | undefined): Promise<boolean> {
  if (!storage) {
    return DEFAULT_START_RELOAD_OFFER;
  }

  try {
    const stored = await storage.get(START_RELOAD_OFFER_STORAGE_KEY);
    return normalizeStartReloadOffer(stored?.[START_RELOAD_OFFER_STORAGE_KEY]);
  } catch {
    return DEFAULT_START_RELOAD_OFFER;
  }
}
