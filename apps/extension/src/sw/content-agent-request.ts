import { injectContentAgent, type ScriptingApiLike } from "./recording-status.js";
import type { SessionRegistry } from "./session-registry.js";

export type ContentAgentRequestReply = { ok: true } | { ok: false; error: string };

/**
 * Answers `content.agent-request`: injects the capture agent into the sender's frame. Only a frame
 * of a recording tab gets it, since the agent is what makes a frame record.
 */
export async function answerContentAgentRequest(
  sessionRegistry: Pick<SessionRegistry, "getByTab">,
  scripting: ScriptingApiLike | undefined,
  tabId: number | undefined,
  frameId: number | undefined
): Promise<ContentAgentRequestReply> {
  const runtime = typeof tabId === "number" ? sessionRegistry.getByTab(tabId) : undefined;

  if (typeof tabId !== "number" || typeof frameId !== "number" || !runtime || runtime.stoppedAt) {
    return { ok: false, error: "the tab is not recording" };
  }

  return (await injectContentAgent(scripting, tabId, frameId))
    ? { ok: true }
    : { ok: false, error: "injection failed" };
}
