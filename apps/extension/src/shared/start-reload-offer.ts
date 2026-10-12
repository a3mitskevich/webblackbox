/**
 * What Start does about reloading the page, in both engines. A popup preference under its own
 * storage key: it is not a recorder setting, so it stays out of the recording profiles.
 * - `ask`: Start asks, with "Reload and record" as the main choice and "Don't ask again";
 * - `always`: Start reloads the page, so its load (first requests, scripts) is recorded;
 * - `never`: Start records the page as it is.
 */

export const START_RELOAD_OFFER_STORAGE_KEY = "webblackbox.startReloadOffer";

export type StartReloadChoice = "ask" | "always" | "never";

export const START_RELOAD_CHOICES: readonly StartReloadChoice[] = ["ask", "always", "never"];
export const DEFAULT_START_RELOAD_OFFER: StartReloadChoice = "ask";

type StorageAreaLike = {
  get(keys?: string[] | string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
};

export function isStartReloadChoice(value: unknown): value is StartReloadChoice {
  return START_RELOAD_CHOICES.includes(value as StartReloadChoice);
}

/**
 * Only a known choice counts; installs that never stored one get the default. Earlier versions
 * stored a boolean: on (ask) stays `ask`, off (start without reload) becomes `never`.
 */
export function normalizeStartReloadOffer(value: unknown): StartReloadChoice {
  if (isStartReloadChoice(value)) {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "ask" : "never";
  }

  return DEFAULT_START_RELOAD_OFFER;
}

/** Never throws: unavailable or failing storage reads as the default. */
export async function loadStartReloadOffer(
  storage: StorageAreaLike | undefined
): Promise<StartReloadChoice> {
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
