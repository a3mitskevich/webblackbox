import type { LiteCaptureAgent } from "webblackbox/lite-capture-agent";
import type { LiteCaptureAgentOptions } from "webblackbox/types";

/** What `content-agent.js` hands to the content script of its frame. */
export type ContentAgentApi = {
  createContentCaptureAgent(options: LiteCaptureAgentOptions): LiteCaptureAgent;
  loadKeyboardMarkerLabel(): Promise<string>;
};

/**
 * Where `content-agent.js` leaves its API: `globalThis` of the extension's isolated world, which
 * the page and other extensions never see. The content script of the same frame reads it there.
 */
export const CONTENT_AGENT_GLOBAL_KEY: unique symbol = Symbol.for("webblackbox.contentAgent");

type AgentScope = { [CONTENT_AGENT_GLOBAL_KEY]?: unknown };

export function publishContentAgent(scope: object, api: ContentAgentApi): void {
  (scope as AgentScope)[CONTENT_AGENT_GLOBAL_KEY] = Object.freeze({ ...api });
}

/** The API `content-agent.js` published in this world, or null before it ran here. */
export function readContentAgent(scope: object): ContentAgentApi | null {
  const candidate = (scope as AgentScope)[CONTENT_AGENT_GLOBAL_KEY];

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const api = candidate as Partial<ContentAgentApi>;

  return typeof api.createContentCaptureAgent === "function" &&
    typeof api.loadKeyboardMarkerLabel === "function"
    ? (api as ContentAgentApi)
    : null;
}
