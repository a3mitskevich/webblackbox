import type { CdpRouter } from "@webblackbox/cdp-router";

import { withCdpCommandTimeout } from "./cdp-command.js";

export type ChildSessionPrimer = Pick<CdpRouter, "enableBaseline" | "enableAutoAttach" | "send">;

/**
 * Enables capture on an auto-attached child session (iframe, worker). Resolves false when a
 * required domain fails or the whole sequence outlasts `timeoutMs`.
 *
 * A child can be gone before it is primed (a worker terminated right after it started), and
 * chrome.debugger may then never answer its session. Priming runs on the session's serial
 * queue, which stop and export wait on, so it must not be able to hang.
 */
export async function primeChildSession(
  router: ChildSessionPrimer,
  tabId: number,
  sessionId: string,
  timeoutMs: number
): Promise<boolean> {
  const outcome = await withCdpCommandTimeout(
    (async () => {
      await router.enableBaseline(tabId, sessionId);
      await router.enableAutoAttach(tabId, undefined, sessionId);
      await router.send({ tabId, sessionId }, "DOMStorage.enable").catch(() => undefined);
      await router.send({ tabId, sessionId }, "Performance.enable").catch(() => undefined);
    })(),
    timeoutMs
  );

  return outcome.ok;
}
