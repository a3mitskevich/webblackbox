import { describe, expect, it, vi } from "vitest";

import {
  loadSourceMapForEmbedding,
  scriptRecordFromResponse,
  scriptRecordFromScriptParsed,
  ScriptSourceMapTracker,
  type RawScriptRecord
} from "./source-maps.js";

const MAP_JSON = JSON.stringify({ version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" });
const RECORD: RawScriptRecord = {
  url: "https://app.test/assets/main.4f3a.js?v=1",
  sourceMapUrl: "main.4f3a.js.map",
  origin: "cdp"
};

describe("scriptRecordFromScriptParsed", () => {
  it("keeps http(s) scripts with a map and their debugger metadata", () => {
    expect(
      scriptRecordFromScriptParsed({
        scriptId: "17",
        url: "https://app.test/main.js",
        sourceMapURL: " main.js.map ",
        hash: "abc",
        length: 512,
        isModule: false,
        executionContextId: 4
      })
    ).toEqual({
      url: "https://app.test/main.js",
      sourceMapUrl: "main.js.map",
      origin: "cdp",
      scriptId: "17",
      hash: "abc",
      length: 512,
      isModule: false
    });
  });

  it("ignores scripts without a map, without a URL or from extensions", () => {
    expect(
      scriptRecordFromScriptParsed({ url: "https://app.test/a.js", sourceMapURL: "" })
    ).toBeNull();
    expect(scriptRecordFromScriptParsed({ url: "", sourceMapURL: "a.map" })).toBeNull();
    expect(
      scriptRecordFromScriptParsed({ url: "chrome-extension://x/c.js", sourceMapURL: "c.map" })
    ).toBeNull();
    expect(scriptRecordFromScriptParsed(null)).toBeNull();
  });
});

describe("scriptRecordFromResponse", () => {
  it("reads SourceMap headers from script responses only", () => {
    const response = {
      type: "Script",
      response: { url: "https://app.test/a.js", headers: { SourceMap: "/maps/a.js.map" } }
    };

    expect(scriptRecordFromResponse(response)).toEqual({
      url: "https://app.test/a.js",
      sourceMapUrl: "/maps/a.js.map",
      origin: "header"
    });
    expect(scriptRecordFromResponse({ ...response, type: "Fetch" })).toBeNull();
    expect(
      scriptRecordFromResponse({ type: "Script", response: { url: "https://app.test/a.js" } })
    ).toBeNull();
  });
});

describe("ScriptSourceMapTracker", () => {
  it("records each script/map pair once and caps scripts and embedded maps", () => {
    const tracker = new ScriptSourceMapTracker({ maxScripts: 2, maxEmbeddedMaps: 1 });
    const other = { ...RECORD, url: "https://app.test/other.js", sourceMapUrl: "other.js.map" };

    expect(tracker.markRecorded(RECORD)).toBe(true);
    // Same script without the query string and with an absolute map URL: still a duplicate.
    expect(
      tracker.markRecorded({
        ...RECORD,
        url: "https://app.test/assets/main.4f3a.js",
        sourceMapUrl: "https://app.test/assets/main.4f3a.js.map",
        origin: "header"
      })
    ).toBe(false);
    expect(tracker.markRecorded(other)).toBe(true);
    expect(tracker.markRecorded({ ...other, url: "https://app.test/third.js" })).toBe(false);

    expect(tracker.reserveEmbed(RECORD)).toBe(true);
    expect(tracker.reserveEmbed(RECORD)).toBe(false);
    expect(tracker.reserveEmbed(other)).toBe(false);
  });

  it("tracks the session byte budget", () => {
    const tracker = new ScriptSourceMapTracker({ maxEmbeddedBytes: 100 });

    tracker.addEmbeddedBytes(60);
    expect(tracker.remainingEmbedBytes()).toBe(40);
    tracker.addEmbeddedBytes(60);
    expect(tracker.remainingEmbedBytes()).toBe(0);
  });
});

describe("loadSourceMapForEmbedding", () => {
  it("fetches the resolved map URL with credentials and validates it", async () => {
    const fetchImpl = vi.fn(async () => okResponse(MAP_JSON));
    const result = await loadSourceMapForEmbedding(RECORD, { maxBytes: 1_000, fetch: fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.test/assets/main.4f3a.js.map",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("accepts the XSSI prefix and rejects responses that are not source maps", async () => {
    expect(
      (
        await loadSourceMapForEmbedding(RECORD, {
          maxBytes: 1_000,
          fetch: async () => okResponse(`)]}'\n${MAP_JSON}`)
        })
      ).ok
    ).toBe(true);
    expect(
      await loadSourceMapForEmbedding(RECORD, {
        maxBytes: 1_000,
        fetch: async () => okResponse("<html>login</html>")
      })
    ).toEqual({ ok: false, error: "response is not a source map" });
  });

  it("reports HTTP errors, declared and streamed oversize bodies, and timeouts", async () => {
    expect(
      await loadSourceMapForEmbedding(RECORD, {
        maxBytes: 1_000,
        fetch: async () => ({ ...okResponse(""), ok: false, status: 403 })
      })
    ).toEqual({ ok: false, error: "HTTP 403" });
    expect(
      await loadSourceMapForEmbedding(RECORD, {
        maxBytes: 10,
        fetch: async () => okResponse(MAP_JSON, { "content-length": "5000" })
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("exceeds") });
    expect(
      await loadSourceMapForEmbedding(RECORD, {
        maxBytes: 10,
        fetch: async () => streamResponse(MAP_JSON)
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("exceeds") });
    expect(
      await loadSourceMapForEmbedding(RECORD, {
        maxBytes: 1_000,
        timeoutMs: 5,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            );
          })
      })
    ).toEqual({ ok: false, error: "timed out" });
  });

  it("decodes inline maps without any network access and caps them", async () => {
    const fetchImpl = vi.fn();
    const inline = {
      ...RECORD,
      sourceMapUrl: `data:application/json;base64,${btoa(MAP_JSON)}`
    };

    expect(
      (await loadSourceMapForEmbedding(inline, { maxBytes: 1_000, fetch: fetchImpl })).ok
    ).toBe(true);
    expect(
      (
        await loadSourceMapForEmbedding(
          { ...RECORD, sourceMapUrl: `data:application/json,${encodeURIComponent(MAP_JSON)}` },
          { maxBytes: 1_000, fetch: fetchImpl }
        )
      ).ok
    ).toBe(true);
    expect(
      await loadSourceMapForEmbedding(inline, { maxBytes: 10, fetch: fetchImpl })
    ).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses unsupported URLs and an exhausted session budget", async () => {
    expect(
      await loadSourceMapForEmbedding(
        { ...RECORD, sourceMapUrl: "file:///etc/app.map" },
        { maxBytes: 1_000 }
      )
    ).toEqual({ ok: false, error: "unsupported source map URL" });
    expect(await loadSourceMapForEmbedding(RECORD, { maxBytes: 0 })).toEqual({
      ok: false,
      error: "session source map budget exhausted"
    });
  });
});

function okResponse(text: string, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer
  };
}

function streamResponse(text: string) {
  const bytes = new TextEncoder().encode(text);

  return {
    ...okResponse(""),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      }
    })
  };
}
