import { describe, expect, it, vi } from "vitest";

import { startWithOptionalReload } from "./start-with-reload.js";

function createDeps(
  options: { mode?: "lite" | "full"; startFails?: boolean; reloadFails?: boolean } = {}
) {
  const calls: string[] = [];
  const deps = {
    start: vi.fn(async () => {
      calls.push("start");

      if (options.startFails) {
        throw new Error("Debugger is already attached");
      }

      return options.mode ?? "full";
    }),
    reload: vi.fn(async (tabId: number) => {
      calls.push(`reload:${tabId}`);

      if (options.reloadFails) {
        throw new Error("No tab with id: 17");
      }
    }),
    stop: vi.fn(async (tabId: number) => {
      calls.push(`stop:${tabId}`);
    })
  };

  return { calls, deps };
}

describe("startWithOptionalReload", () => {
  it.each(["lite", "full"] as const)(
    "reloads a %s recording only after its capture has started",
    async (mode) => {
      const { calls, deps } = createDeps({ mode });

      await expect(startWithOptionalReload(17, true, deps)).resolves.toBe(mode);
      expect(calls).toEqual(["start", "reload:17"]);
    }
  );

  it("starts without a reload when none was asked for", async () => {
    const { calls, deps } = createDeps();

    await startWithOptionalReload(17, false, deps);

    expect(calls).toEqual(["start"]);
  });

  it("does not reload when the start fails", async () => {
    const { calls, deps } = createDeps({ startFails: true });

    await expect(startWithOptionalReload(17, true, deps)).rejects.toThrow(
      "Debugger is already attached"
    );
    expect(calls).toEqual(["start"]);
  });

  it("stops the new recording and reports the error when the reload fails", async () => {
    const { calls, deps } = createDeps({ reloadFails: true });

    await expect(startWithOptionalReload(17, true, deps)).rejects.toThrow("No tab with id: 17");
    expect(calls).toEqual(["start", "reload:17", "stop:17"]);
  });
});
