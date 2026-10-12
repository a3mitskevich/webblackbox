/**
 * The export passphrase, remembered until the browser closes: the first export of a browser
 * session asks for it, later exports reuse it. It lives in the worker's memory and in
 * `chrome.storage.session` (memory-backed, trusted contexts only), never on disk, so a restarted
 * worker still has it and a restarted browser does not.
 */

export const EXPORT_PASSPHRASE_STORAGE_KEY = "webblackbox.exportPassphrase";

export type PassphraseStorageAreaLike = {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string): Promise<void>;
};

export type ExportPassphraseStore = {
  /** The remembered passphrase, if any. */
  get: () => Promise<string | undefined>;
  remember: (passphrase: string) => Promise<void>;
  forget: () => Promise<void>;
};

export function createExportPassphraseStore(
  area: PassphraseStorageAreaLike | undefined
): ExportPassphraseStore {
  /** `null` until the area was read once (a new worker of the same browser session). */
  let cached: string | undefined | null = null;

  async function get(): Promise<string | undefined> {
    if (cached !== null) {
      return cached;
    }

    try {
      const value = (await area?.get(EXPORT_PASSPHRASE_STORAGE_KEY))?.[
        EXPORT_PASSPHRASE_STORAGE_KEY
      ];
      cached = typeof value === "string" && value.length > 0 ? value : undefined;
    } catch (error) {
      console.warn("[WebBlackbox] failed to read the remembered export passphrase", error);
      cached = undefined;
    }

    return cached;
  }

  async function remember(passphrase: string): Promise<void> {
    cached = passphrase;
    await area?.set({ [EXPORT_PASSPHRASE_STORAGE_KEY]: passphrase }).catch((error) => {
      // Still remembered by this worker.
      console.warn("[WebBlackbox] failed to keep the export passphrase for this session", error);
    });
  }

  async function forget(): Promise<void> {
    // Storage first: a later worker must not read back what this one forgot.
    try {
      if (area?.remove) {
        await area.remove(EXPORT_PASSPHRASE_STORAGE_KEY);
      } else {
        await area?.set({ [EXPORT_PASSPHRASE_STORAGE_KEY]: "" });
      }
    } catch (error) {
      console.warn("[WebBlackbox] failed to drop the remembered export passphrase", error);
      await area?.set({ [EXPORT_PASSPHRASE_STORAGE_KEY]: "" }).catch(() => undefined);
    }

    cached = undefined;
  }

  return { get, remember, forget };
}
