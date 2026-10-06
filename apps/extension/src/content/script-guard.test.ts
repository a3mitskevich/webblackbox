import { describe, expect, it } from "vitest";

import { CONTENT_SCRIPT_GUARD_KEY } from "../shared/content-injection.js";
import { claimContentScriptSlot } from "./script-guard.js";

describe("content script guard", () => {
  it("lets only the first copy in a frame start", () => {
    const scope: Record<string, unknown> = {};

    expect(claimContentScriptSlot(scope, () => true)).toBe(true);
    expect(claimContentScriptSlot(scope, () => true)).toBe(false);
    expect(scope[CONTENT_SCRIPT_GUARD_KEY]).toBeDefined();
  });

  it("lets a fresh copy replace one orphaned by an extension reload", () => {
    const scope: Record<string, unknown> = {};
    let firstAlive = true;
    claimContentScriptSlot(scope, () => firstAlive);

    firstAlive = false;

    expect(claimContentScriptSlot(scope, () => true)).toBe(true);
    expect(claimContentScriptSlot(scope, () => true)).toBe(false);
  });

  it("ignores a stray value under the guard key", () => {
    const scope: Record<string, unknown> = { [CONTENT_SCRIPT_GUARD_KEY]: true };

    expect(claimContentScriptSlot(scope, () => true)).toBe(true);
  });
});
