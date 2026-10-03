import { describe, expect, it, vi } from "vitest";

import {
  createConcurrencyLimiter,
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

  it("charges the session byte budget only for maps that still fit", () => {
    const tracker = new ScriptSourceMapTracker({ maxEmbeddedBytes: 100 });

    expect(tracker.tryAddEmbeddedBytes(60)).toBe(true);
    expect(tracker.remainingEmbedBytes()).toBe(40);
    // Two maps fetched concurrently against the same remaining budget: the second one no
    // longer fits and is not counted.
    expect(tracker.tryAddEmbeddedBytes(60)).toBe(false);
    expect(tracker.remainingEmbedBytes()).toBe(40);
    expect(tracker.tryAddEmbeddedBytes(40)).toBe(true);
    expect(tracker.remainingEmbedBytes()).toBe(0);
  });
});

describe("createConcurrencyLimiter", () => {
  it("runs at most the limit at once and starts waiting tasks in order", async () => {
    const limit = createConcurrencyLimiter(2);
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const tasks = [0, 1, 2, 3].map((index) =>
      limit(async () => {
        started.push(index);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return index;
      })
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    // A task queued while a slot is being handed over must still wait its turn.
    const late = limit(async () => {
      started.push(4);
      return 4;
    });
    releases.shift()?.();
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    releases.shift()?.();

    await expect(Promise.all([...tasks, late])).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("frees the slot when a task fails", async () => {
    const limit = createConcurrencyLimiter(1);

    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limit(async () => "next")).resolves.toBe("next");
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
