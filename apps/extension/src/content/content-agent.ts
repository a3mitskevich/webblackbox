import { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions } from "webblackbox/types";

import { loadExtensionLocale, type ExtensionLocale } from "../shared/i18n.js";

export function createContentCaptureAgent(options: LiteCaptureAgentOptions): LiteCaptureAgent {
  return new LiteCaptureAgent(options);
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
