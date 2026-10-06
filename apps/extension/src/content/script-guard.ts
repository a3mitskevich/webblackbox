import { CONTENT_SCRIPT_GUARD_KEY } from "../shared/content-injection.js";

type ScriptSlot = {
  /** False once the copy that claimed the slot lost its extension context. */
  isAlive: () => boolean;
};

/**
 * The content script can reach a frame twice (registered at `document_start` and injected on
 * Start or after a navigation). The first copy claims the isolated world; a later copy runs only
 * when the claimant is orphaned (extension reloaded or updated), so listeners never double up.
 */
export function claimContentScriptSlot(
  scope: Record<string, unknown>,
  isAlive: () => boolean
): boolean {
  const existing = scope[CONTENT_SCRIPT_GUARD_KEY] as ScriptSlot | undefined;

  if (existing && typeof existing.isAlive === "function" && existing.isAlive()) {
    return false;
  }

  const slot: ScriptSlot = { isAlive };
  scope[CONTENT_SCRIPT_GUARD_KEY] = slot;
  return true;
}
