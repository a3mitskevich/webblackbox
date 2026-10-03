import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions } from "webblackbox/types";

import { loadExtensionLocale, translateExtensionMessage } from "../shared/i18n.js";

export function createContentCaptureAgent(options: LiteCaptureAgentOptions): LiteCaptureAgent {
  return new LiteCaptureAgent(options);
}

/**
 * Lives here, not in the content script: the UI dictionaries then load only with the capture
 * agent, instead of being parsed on every page the content script is injected into.
 */
export async function loadKeyboardMarkerLabel(): Promise<string> {
  return translateExtensionMessage(await loadExtensionLocale(), "contentKeyboardMarker");
}
