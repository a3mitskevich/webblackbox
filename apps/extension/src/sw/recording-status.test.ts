import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import { DOM_RECORDER_NONCE_SETTER_KEY } from "webblackbox/dom-recorder-bridge";
import { INJECTED_BRIDGE_NONCE_SETTER_KEY } from "webblackbox/injected-hooks";
import { describe, expect, it, vi } from "vitest";

import { ensureInjectedHooks, recordsDom, type ScriptingApiLike } from "./recording-status.js";

type Injection = {
  target: { tabId: number; frameIds?: number[] };
  world?: string;
  files?: string[];
  args?: unknown[];
};

function createScripting(fail: (injection: Injection) => boolean = () => false) {
  const injections: Injection[] = [];
  const scripting = {
    executeScript: vi.fn(async (injection: Injection) => {
      injections.push(injection);

      if (fail(injection)) {
        throw new Error("Cannot access contents of the page");
      }

      return [];
    })
  } as unknown as ScriptingApiLike;

  return { scripting, injections };
}

const summarize = (injections: Injection[]) =>
  injections.map((injection) => ({
    frameIds: injection.target.frameIds,
    world: injection.world,
    what: injection.files?.[0] ?? injection.args?.[0]
  }));

describe("ensureInjectedHooks", () => {
  it("adds the rrweb DOM recorder with its nonce to the top frame when asked", async () => {
    const { scripting, injections } = createScripting();

    await ensureInjectedHooks(scripting, 7, "nonce-1", undefined, { domRecorder: true });

    expect(summarize(injections)).toEqual([
      { frameIds: undefined, world: "MAIN", what: "injected.js" },
      { frameIds: undefined, world: "MAIN", what: INJECTED_BRIDGE_NONCE_SETTER_KEY },
      { frameIds: [0], world: "MAIN", what: "injected-dom.js" },
      { frameIds: [0], world: "MAIN", what: DOM_RECORDER_NONCE_SETTER_KEY }
    ]);
    expect(injections.at(-1)?.args).toEqual([DOM_RECORDER_NONCE_SETTER_KEY, "nonce-1"]);
  });

  it("leaves child frames and DOM-less profiles without it", async () => {
    const child = createScripting();
    await ensureInjectedHooks(child.scripting, 7, "nonce-1", 12, { domRecorder: true });
    const off = createScripting();
    await ensureInjectedHooks(off.scripting, 7, "nonce-1");

    expect(child.injections.map((injection) => injection.files?.[0])).not.toContain(
      "injected-dom.js"
    );
    expect(off.injections.map((injection) => injection.files?.[0])).not.toContain(
      "injected-dom.js"
    );
  });

  it("survives a page that refuses the recorder", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { scripting } = createScripting(
      (injection) => injection.files?.[0] === "injected-dom.js"
    );

    await expect(
      ensureInjectedHooks(scripting, 7, "nonce-1", 0, { domRecorder: true })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("recordsDom", () => {
  it("follows the dom category", () => {
    expect(recordsDom(DEFAULT_CAPTURE_POLICY)).toBe(true);
    expect(
      recordsDom({
        ...DEFAULT_CAPTURE_POLICY,
        categories: { ...DEFAULT_CAPTURE_POLICY.categories, dom: "off" }
      })
    ).toBe(false);
    expect(recordsDom(undefined)).toBe(false);
  });
});
