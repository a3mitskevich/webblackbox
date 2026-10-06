import type { CaptureMode } from "@webblackbox/protocol";

export type StartWithReloadDeps = {
  /** Starts the session; resolves once its capture is live (Full: CDP attached and enabled). */
  start: () => Promise<CaptureMode>;
  reload: (tabId: number) => Promise<void>;
  stop: (tabId: number) => Promise<void>;
};

/**
 * Starts recording and, when asked, reloads the tab afterwards so the archive holds the page
 * load from scratch (document request, first scripts, early console and errors). Same order in
 * both engines: the reload is only issued once the start resolved. A failed reload stops the
 * recording it was meant for and reports the error.
 */
export async function startWithOptionalReload(
  tabId: number,
  reloadPage: boolean,
  deps: StartWithReloadDeps
): Promise<CaptureMode> {
  const mode = await deps.start();

  if (!reloadPage) {
    return mode;
  }

  try {
    await deps.reload(tabId);
  } catch (error) {
    await deps.stop(tabId);
    throw error;
  }

  return mode;
}
