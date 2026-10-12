import { createPageWorldDomRecorderFactory } from "webblackbox/dom-recorder-bridge";
import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions } from "webblackbox/types";

import { loadExtensionLocale, type ExtensionLocale } from "../shared/i18n.js";
import { publishContentAgent } from "./content-agent-api.js";

/**
 * The agent records the DOM through the rrweb recorder that the service worker injects into the
 * page's MAIN world (`injected-dom.js`); its own DOM capture takes over where rrweb cannot run.
 */
export function createContentCaptureAgent(options: LiteCaptureAgentOptions): LiteCaptureAgent {
  return new LiteCaptureAgent({
    domRecorder: createPageWorldDomRecorderFactory(),
    ...options
  });
}

/**
 * `contentKeyboardMarker` of each UI dictionary (a test keeps them equal). The agent runs in every
 * recorded frame, and importing the dictionaries themselves would bundle all three of them into
 * content-agent.js for this one label.
 */
export const KEYBOARD_MARKER_LABELS: Readonly<Record<ExtensionLocale, string>> = {
  en: "Keyboard marker",
  ru: "Маркер с клавиатуры",
  "zh-CN": "键盘标记"
};

/** In the language chosen in Options (Chrome's language on Auto). */
export async function loadKeyboardMarkerLabel(): Promise<string> {
  return KEYBOARD_MARKER_LABELS[await loadExtensionLocale()];
}

/**
 * Runs when the service worker injects `content-agent.js` into a recording frame (see
 * `content.agent-request`): hands the agent to the content script of the same isolated world.
 */
export function startContentAgent(): void {
  publishContentAgent(globalThis, { createContentCaptureAgent, loadKeyboardMarkerLabel });
}
