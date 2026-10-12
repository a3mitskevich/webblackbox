import { describe, expect, it } from "vitest";

import {
  createCaptureFallback,
  isDebuggerRestrictedUrl,
  parseCaptureFallback,
  ranInFullEngine,
  toCaptureFallbackReason
} from "./capture-fallback.js";

describe("isDebuggerRestrictedUrl", () => {
  it("flags pages Chrome never lets an extension debug", () => {
    for (const url of [
      "chrome://settings",
      "chrome-extension://abcdef/options.html",
      "chrome-untrusted://terminal/",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://example.test/",
      "about:settings",
      "https://chromewebstore.google.com/detail/x/abc",
      "https://chrome.google.com/webstore/detail/x"
    ]) {
      expect(isDebuggerRestrictedUrl(url), url).toBe(true);
    }
  });

  it("lets ordinary pages, blank pages and unknown URLs through", () => {
    for (const url of [
      "https://example.test/app",
      "http://localhost:3000/",
      "file:///tmp/page.html",
      "about:blank",
      "https://chrome.google.com/other",
      "tab:7",
      undefined
    ]) {
      expect(isDebuggerRestrictedUrl(url), String(url)).toBe(false);
    }
  });
});

describe("capture fallback records", () => {
  it("maps Chrome's detach reasons", () => {
    expect(toCaptureFallbackReason("canceled_by_user")).toBe("canceled-by-user");
    expect(toCaptureFallbackReason("target_closed")).toBe("target-closed");
    expect(toCaptureFallbackReason("something_new")).toBe("detached");
  });

  it("parses what it creates and rejects anything else", () => {
    const fallback = createCaptureFallback({ at: 5, reason: "attach-failed", detail: "  busy  " });

    expect(fallback).toEqual({
      at: 5,
      reason: "attach-failed",
      from: "full",
      to: "lite",
      detail: "busy"
    });
    expect(parseCaptureFallback(JSON.parse(JSON.stringify(fallback)))).toEqual(fallback);
    expect(parseCaptureFallback({ ...fallback, reason: "nope" })).toBeUndefined();
    expect(parseCaptureFallback({ ...fallback, to: "full" })).toBeUndefined();
    expect(parseCaptureFallback({ ...fallback, at: "5" })).toBeUndefined();
    expect(parseCaptureFallback(null)).toBeUndefined();
    expect(
      createCaptureFallback({ at: 1, reason: "detached", detail: "x".repeat(500) }).detail
    ).toHaveLength(200);
  });

  it("counts a recording that left Full after it started as recorded in Full", () => {
    expect(ranInFullEngine({ mode: "full" })).toBe(true);
    expect(ranInFullEngine({ mode: "lite" })).toBe(false);
    expect(
      ranInFullEngine({
        mode: "lite",
        captureFallback: createCaptureFallback({ at: 1, reason: "canceled-by-user" })
      })
    ).toBe(true);
    expect(
      ranInFullEngine({
        mode: "lite",
        captureFallback: createCaptureFallback({ at: 1, reason: "restricted-page" })
      })
    ).toBe(false);
  });
});
