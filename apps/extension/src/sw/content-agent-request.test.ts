import { describe, expect, it, vi } from "vitest";

import { EXTENSION_FILES } from "../shared/extension-files.js";
import { answerContentAgentRequest } from "./content-agent-request.js";
import type { ScriptingApiLike } from "./recording-status.js";
import type { SessionRuntime } from "./session-registry.js";

function createScripting(fail = false): ScriptingApiLike {
  return {
    executeScript: vi.fn(async () => {
      if (fail) {
        throw new Error("Frame with ID 2 was removed.");
      }

      return [];
    })
  } as unknown as ScriptingApiLike;
}

function registryWith(runtime?: Partial<SessionRuntime>) {
  return { getByTab: (tabId: number) => (tabId === 7 ? (runtime as SessionRuntime) : undefined) };
}

describe("answerContentAgentRequest", () => {
  it("injects the capture agent into the requesting frame of a recording tab", async () => {
    const scripting = createScripting();

    await expect(answerContentAgentRequest(registryWith({}), scripting, 7, 2)).resolves.toEqual({
      ok: true
    });
    expect(scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [2] },
      world: "ISOLATED",
      files: [EXTENSION_FILES.contentAgent]
    });
  });

  it("injects nothing outside a recording", async () => {
    const scripting = createScripting();

    for (const [registry, tabId, frameId] of [
      [registryWith(undefined), 7, 0],
      [registryWith({ stoppedAt: 1 }), 7, 0],
      [registryWith({}), 8, 0],
      [registryWith({}), undefined, 0],
      [registryWith({}), 7, undefined]
    ] as const) {
      await expect(answerContentAgentRequest(registry, scripting, tabId, frameId)).resolves.toEqual(
        {
          ok: false,
          error: "the tab is not recording"
        }
      );
    }

    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it("reports a failed injection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      answerContentAgentRequest(registryWith({}), createScripting(true), 7, 2)
    ).resolves.toEqual({ ok: false, error: "injection failed" });
  });
});
