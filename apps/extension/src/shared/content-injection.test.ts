import { describe, expect, it } from "vitest";

import {
  CONTENT_SCRIPT_ID,
  createContentScriptRegistration,
  DEFAULT_CONTENT_INJECTION_MODE,
  normalizeContentInjectionMode,
  planContentScriptRegistration
} from "./content-injection.js";

describe("content injection mode", () => {
  it("keeps today's behaviour by default and for unknown stored values", () => {
    expect(DEFAULT_CONTENT_INJECTION_MODE).toBe("always");

    for (const stored of [undefined, null, "", "never", 1, { mode: "on-start" }]) {
      expect(normalizeContentInjectionMode(stored)).toBe("always");
    }

    expect(normalizeContentInjectionMode("on-start")).toBe("on-start");
    expect(normalizeContentInjectionMode("always")).toBe("always");
  });

  it("registers the same script the manifest used to declare", () => {
    expect(createContentScriptRegistration()).toEqual({
      id: CONTENT_SCRIPT_ID,
      matches: ["<all_urls>"],
      js: ["content.js"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: true
    });
  });

  it("plans only the change the registration needs", () => {
    expect(planContentScriptRegistration("always", [])).toBe("register");
    expect(planContentScriptRegistration("always", ["other"])).toBe("register");
    expect(planContentScriptRegistration("always", [CONTENT_SCRIPT_ID])).toBe("none");
    expect(planContentScriptRegistration("on-start", [CONTENT_SCRIPT_ID])).toBe("unregister");
    expect(planContentScriptRegistration("on-start", [])).toBe("none");
  });
});
