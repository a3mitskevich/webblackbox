import type { ChromeApi } from "../shared/chrome-api.js";
import {
  CONTENT_INJECTION_STORAGE_KEY,
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  createContentScriptRegistration,
  normalizeContentInjectionMode,
  planContentScriptRegistration,
  type ContentInjectionMode
} from "../shared/content-injection.js";

type InjectionChromeApi = Pick<ChromeApi, "runtime" | "scripting" | "storage">;

export type ContentInjectionController = {
  /**
   * Reads the setting and brings the dynamic registration in line with it. Calls are serialized,
   * so overlapping triggers (boot, storage change) never race on the same script id.
   */
  sync(): Promise<ContentInjectionMode>;
  /** The mode in effect: "on-start" whenever the build cannot register all-sites scripts. */
  currentMode(): ContentInjectionMode;
};

/**
 * Keeps the all-sites content script registered ("always") or unregistered ("on-start"). The
 * store-safe build has no persistent host access, so nothing is registered there and injection
 * always waits for Start.
 */
export function createContentInjectionController(
  chromeApi: InjectionChromeApi | null
): ContentInjectionController {
  const canRegister = canRegisterAllSitesScript(chromeApi);
  let mode: ContentInjectionMode = canRegister ? "always" : "on-start";
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (): Promise<ContentInjectionMode> => {
    const values = await chromeApi?.storage?.local
      .get(CONTENT_INJECTION_STORAGE_KEY)
      .catch(() => undefined);
    const requested = normalizeContentInjectionMode(values?.[CONTENT_INJECTION_STORAGE_KEY]);
    mode = canRegister ? requested : "on-start";

    if (!canRegister) {
      return mode;
    }

    try {
      await applyRegistration(chromeApi, mode);
    } catch (error) {
      console.warn("[WebBlackbox] failed to sync the content script registration", error);
    }

    return mode;
  };

  return {
    sync() {
      const next = queue.then(run, run);
      queue = next;
      return next;
    },
    currentMode() {
      return mode;
    }
  };
}

async function applyRegistration(
  chromeApi: InjectionChromeApi | null,
  mode: ContentInjectionMode
): Promise<void> {
  const scripting = chromeApi?.scripting;
  const registered =
    (await scripting?.getRegisteredContentScripts?.({ ids: [CONTENT_SCRIPT_ID] })) ?? [];
  const action = planContentScriptRegistration(
    mode,
    registered.map((script) => script.id)
  );

  if (action === "register") {
    await scripting?.registerContentScripts?.([createContentScriptRegistration()]);
  } else if (action === "unregister") {
    await scripting?.unregisterContentScripts?.({ ids: [CONTENT_SCRIPT_ID] });
  }
}

/** Dynamic registration needs the scripting API and host access to every site. */
function canRegisterAllSitesScript(chromeApi: InjectionChromeApi | null): boolean {
  const scripting = chromeApi?.scripting;

  if (
    !scripting?.registerContentScripts ||
    !scripting.unregisterContentScripts ||
    !scripting.getRegisteredContentScripts
  ) {
    return false;
  }

  const hostPermissions = chromeApi?.runtime?.getManifest?.().host_permissions ?? [];
  return hostPermissions.includes("<all_urls>");
}

/** Frame URLs the all-sites registration would match; others cannot take the script. */
export function isInjectableFrameUrl(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

/**
 * Injects the content script into one committed frame as early as the API allows. Used for
 * navigations of a recorded tab when no registration covers new documents.
 */
export async function injectContentScriptIntoFrame(
  chromeApi: Pick<ChromeApi, "scripting"> | null,
  tabId: number,
  frameId: number
): Promise<void> {
  await chromeApi?.scripting
    ?.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "ISOLATED",
      files: [CONTENT_SCRIPT_FILE],
      injectImmediately: true
    })
    .catch(() => undefined);
}
