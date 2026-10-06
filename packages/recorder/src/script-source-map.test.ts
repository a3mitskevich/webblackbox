import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { DefaultEventNormalizer } from "./normalizer.js";
import { WebBlackboxRecorder } from "./recorder.js";
import { normalizeScriptSourceMapPayload } from "./script-source-map.js";

describe("normalizeScriptSourceMapPayload", () => {
  it("keeps hashed bundle paths, resolves relative maps and drops query strings", () => {
    expect(
      normalizeScriptSourceMapPayload({
        url: "https://cdn.x.test/assets/main.4f3a9c2b.js?v=7&token=abc",
        sourceMapUrl: "main.4f3a9c2b.js.map?sig=secret",
        origin: "cdp",
        scriptId: 42,
        hash: "deadbeef",
        length: 1234.4,
        isModule: true,
        executionContextId: 3
      })
    ).toEqual({
      script: "https://cdn.x.test/assets/main.4f3a9c2b.js",
      sourceMap: "https://cdn.x.test/assets/main.4f3a9c2b.js.map",
      origin: "cdp",
      scriptId: "42",
      hash: "deadbeef",
      length: 1234,
      isModule: true
    });
  });

  it("flags inline maps without copying the data URL", () => {
    const payload = normalizeScriptSourceMapPayload({
      url: "https://x.test/app.js",
      sourceMapUrl: "data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==",
      origin: "comment",
      map: { contentHash: "abc123", size: 18 }
    });

    expect(payload).toEqual({
      script: "https://x.test/app.js",
      inlineMap: true,
      origin: "comment",
      map: { contentHash: "abc123", size: 18 }
    });
    expect(JSON.stringify(payload)).not.toContain("base64");
  });

  it("drops scripts without a usable map reference or with a bad origin", () => {
    expect(
      normalizeScriptSourceMapPayload({ url: "https://x.test/app.js", origin: "cdp" })
    ).toBeNull();
    expect(
      normalizeScriptSourceMapPayload({
        url: "https://x.test/app.js",
        sourceMapUrl: "file:///etc/app.js.map",
        origin: "cdp"
      })
    ).toBeNull();
    expect(
      normalizeScriptSourceMapPayload({
        url: "chrome-extension://abc/content.js",
        sourceMapUrl: "content.js.map",
        origin: "cdp"
      })
    ).toBeNull();
    expect(
      normalizeScriptSourceMapPayload({
        url: "https://x.test/app.js",
        sourceMapUrl: "app.js.map",
        origin: "guess"
      })
    ).toBeNull();
    expect(normalizeScriptSourceMapPayload("nope")).toBeNull();
  });

  it("caps error text", () => {
    const payload = normalizeScriptSourceMapPayload({
      url: "https://x.test/app.js",
      sourceMapUrl: "app.js.map",
      origin: "header",
      mapError: "x".repeat(500)
    });

    expect(payload?.mapError?.length).toBe(200);
  });
});

describe("sys.script normalization", () => {
  it("maps system and content script records, ignores CDP raw events with the same name", () => {
    const normalizer = new DefaultEventNormalizer();
    const raw = {
      rawType: "script",
      tabId: 1,
      sid: "S-1",
      t: 1,
      mono: 1,
      payload: { url: "https://x.test/app.js", sourceMapUrl: "app.js.map", origin: "comment" }
    };

    expect(normalizer.normalize({ ...raw, source: "system" })?.eventType).toBe("sys.script");
    expect(normalizer.normalize({ ...raw, source: "content" })?.eventType).toBe("sys.script");
    expect(normalizer.normalize({ ...raw, source: "cdp" })).toBeNull();
    expect(
      normalizer.normalize({ ...raw, source: "content", payload: { url: "https://x.test/a.js" } })
    ).toBeNull();
  });

  it("survives recorder redaction with the hashed bundle name intact", () => {
    const recorder = new WebBlackboxRecorder(DEFAULT_RECORDER_CONFIG);
    const result = recorder.ingest({
      source: "system",
      rawType: "script",
      tabId: 1,
      sid: "S-1",
      t: 1,
      mono: 1,
      payload: {
        url: "https://x.test/assets/index-BxC3kD9a.js",
        sourceMapUrl: "index-BxC3kD9a.js.map",
        origin: "cdp"
      }
    });

    expect(result.event?.type).toBe("sys.script");
    expect(result.event?.privacy?.category).toBe("system");
    expect(result.event?.data).toMatchObject({
      script: "https://x.test/assets/index-BxC3kD9a.js",
      sourceMap: "https://x.test/assets/index-BxC3kD9a.js.map"
    });
  });
});
