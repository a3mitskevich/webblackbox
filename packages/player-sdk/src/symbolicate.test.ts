import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { build } from "esbuild";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { parseSourceMap, SourceMapError } from "./source-map.js";
import {
  collectScriptSourceMaps,
  createArchiveSymbolicator,
  createSourceMapFileProvider,
  createSymbolServerProvider,
  extractEventStack,
  SourceMapSymbolicator,
  type SourceMapProvider
} from "./symbolicate.js";

const SCRIPT_URL = "https://cdn.example.test/assets/app.min.js";

const CART_SOURCE = [
  "export type Item = { price: number; qty: number };",
  "",
  "export function computeTotal(items: Item[]): number {",
  "  let total = 0;",
  "  for (const item of items) {",
  "    if (item.qty < 0) {",
  "      throw new RangeError(`Invalid quantity for price ${item.price}`);",
  "    }",
  "    total += item.price * item.qty;",
  "  }",
  "  return total;",
  "}",
  ""
].join("\n");

const APP_SOURCE = [
  'import { computeTotal, type Item } from "./cart";',
  "",
  "export function checkout(cart: { items: Item[] }): number {",
  "  const total = computeTotal(cart.items);",
  "  return total;",
  "}",
  "",
  "(globalThis as Record<string, unknown>).runCheckout = () =>",
  "  checkout({ items: [{ price: 2, qty: -1 }] });",
  ""
].join("\n");

type Fixture = { code: string; map: string; stack: string };

let fixture: Fixture;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "wb-symbolicate-"));
  await writeFile(join(workDir, "cart.ts"), CART_SOURCE);
  await writeFile(join(workDir, "app.ts"), APP_SOURCE);

  const result = await build({
    entryPoints: [join(workDir, "app.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    sourcemap: "external",
    sourcesContent: true,
    outfile: join(workDir, "out", "app.min.js"),
    write: false,
    logLevel: "silent"
  });
  const code = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text ?? "";
  const map = result.outputFiles.find((file) => file.path.endsWith(".map"))?.text ?? "";
  fixture = { code, map, stack: captureBundleStack(code) };
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Runs the bundle and returns the bundle's own frames as V8 prints them. Vitest installs an
 * `Error.prepareStackTrace` that rewrites positions, so the default formatter is restored while
 * the stack is rendered (stacks render lazily, on first `.stack` read).
 */
function captureBundleStack(code: string): string {
  const sandbox: Record<string, unknown> = {};
  const previous = Error.prepareStackTrace;

  runInNewContext(code, sandbox, { filename: `${SCRIPT_URL}?v=3` });
  // Deleting the hook (not assigning `undefined`) brings back V8's default formatting.
  Reflect.deleteProperty(Error, "prepareStackTrace");

  try {
    (sandbox.runCheckout as () => void)();
    return "";
  } catch (error) {
    const lines = String((error as { stack?: unknown }).stack ?? "").split("\n");
    return [lines[0], ...lines.filter((line) => line.includes(SCRIPT_URL))].join("\n");
  } finally {
    if (previous) {
      Error.prepareStackTrace = previous;
    }
  }
}

function staticProvider(map: string, name = "static"): SourceMapProvider {
  return {
    name,
    load: async () => ({ content: map, mapUrl: `${SCRIPT_URL}.map` })
  };
}

describe("symbolicating an esbuild-minified bundle", () => {
  it("throws from a single minified line", () => {
    expect(fixture.code.trimEnd().split("\n").length).toBeLessThanOrEqual(2);
    expect(fixture.stack).toContain(`${SCRIPT_URL}?v=3:1:`);
  });

  it("maps a real V8 stack back to original files, lines, names and source", async () => {
    const symbolicator = new SourceMapSymbolicator({ providers: [staticProvider(fixture.map)] });
    const frames = await symbolicator.symbolicateStack(fixture.stack);
    const [throwing, caller] = frames;

    expect(throwing?.status).toBe("mapped");
    expect(throwing?.original?.source).toMatch(/cart\.ts$/u);
    expect(throwing?.original?.line).toBe(7);
    expect(throwing?.original?.functionName).toBe("computeTotal");
    expect(throwing?.snippet?.highlightLine).toBe(7);
    expect(throwing?.snippet?.lines.join("\n")).toContain("throw new RangeError");
    expect(throwing?.mapSource).toBe("static");

    expect(caller?.status).toBe("mapped");
    expect(caller?.original?.source).toMatch(/app\.ts$/u);
    expect(caller?.original?.line).toBe(4);
    expect(caller?.original?.functionName).toBe("checkout");
  });

  it("loads each script's map once and reports frames of unknown scripts", async () => {
    const load = vi.fn<SourceMapProvider["load"]>(async () => ({ content: fixture.map }));
    const symbolicator = new SourceMapSymbolicator({ providers: [{ name: "spy", load }] });
    const stack = `${fixture.stack}\n    at other (https://elsewhere.test/x.js:1:1)`;

    await symbolicator.symbolicateStack(stack);
    await symbolicator.symbolicateStack(stack);

    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map(([request]) => request.scriptUrl)).toEqual([
      SCRIPT_URL,
      "https://elsewhere.test/x.js"
    ]);
  });

  it("serves maps embedded in an archive via the recorded script table", async () => {
    const events = [
      scriptEvent({ script: SCRIPT_URL, sourceMap: `${SCRIPT_URL}.map`, origin: "cdp" }),
      scriptEvent({
        script: SCRIPT_URL,
        sourceMap: `${SCRIPT_URL}.map`,
        origin: "cdp",
        map: { contentHash: "map-hash", size: fixture.map.length }
      })
    ];
    const getBlob = vi.fn(async (hash: string) =>
      hash === "map-hash"
        ? { mime: "application/json", bytes: new TextEncoder().encode(fixture.map) }
        : null
    );
    const symbolicator = createArchiveSymbolicator({
      query: ({ types }) => events.filter((event) => types.includes(event.type)),
      getBlob
    });
    const [frame] = await symbolicator.symbolicateStack(fixture.stack);

    expect(frame?.status).toBe("mapped");
    expect(frame?.mapSource).toBe("archive");
    expect(getBlob).toHaveBeenCalledWith("map-hash");
  });

  it("matches dropped map files by recorded map name and longest path suffix", async () => {
    const wrong = vi.fn(async () => "{}");
    const provider = createSourceMapFileProvider([
      { path: "other-build/app.min.js.map", load: wrong },
      { path: "dist/assets/app.min.js.map", load: async () => fixture.map }
    ]);
    const symbolicator = new SourceMapSymbolicator({ providers: [provider] });
    const [frame] = await symbolicator.symbolicateStack(fixture.stack);

    expect(frame?.status).toBe("mapped");
    expect(frame?.mapSource).toBe("files");
    expect(wrong).not.toHaveBeenCalled();
  });

  it("fetches from the configured symbol server only, by map file name", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      const found = url.endsWith("/app.min.js.map");
      return {
        ok: found,
        status: found ? 200 : 404,
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => new TextEncoder().encode(found ? fixture.map : "").buffer
      };
    });
    const provider = createSymbolServerProvider({
      baseUrl: "https://symbols.internal.test/maps?token=x",
      fetch: fetchImpl
    });
    const symbolicator = new SourceMapSymbolicator({
      providers: [provider],
      scripts: new Map([
        [
          SCRIPT_URL,
          { script: SCRIPT_URL, sourceMap: "https://attacker.test/evil.map", inlineMap: false }
        ]
      ])
    });
    const [frame] = await symbolicator.symbolicateStack(fixture.stack);

    expect(frame?.status).toBe("mapped");
    expect(requested).toEqual([
      "https://symbols.internal.test/maps/evil.map",
      "https://symbols.internal.test/maps/app.min.js.map"
    ]);
  });

  it("rejects oversized symbol server responses and non-http base URLs", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-length" ? "999999" : null) },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0)
    }));
    const symbolicator = new SourceMapSymbolicator({
      providers: [
        createSymbolServerProvider({
          baseUrl: "https://symbols.test/",
          fetch: fetchImpl,
          maxBytes: 1_000
        })
      ]
    });
    const [frame] = await symbolicator.symbolicateStack(fixture.stack);

    expect(frame?.status).toBe("map-error");
    expect(frame?.error).toContain("limit");
    expect(() => createSymbolServerProvider({ baseUrl: "file:///maps", fetch: fetchImpl })).toThrow(
      /http/u
    );
  });

  it("reports recorder-side embedding failures when no provider has the map", async () => {
    const symbolicator = new SourceMapSymbolicator({
      providers: [],
      scripts: new Map([
        [SCRIPT_URL, { script: SCRIPT_URL, inlineMap: false, mapError: "HTTP 403" }]
      ])
    });
    const [frame] = await symbolicator.symbolicateStack(fixture.stack);

    expect(frame).toMatchObject({ status: "map-error", error: "recorder: HTTP 403" });
  });
});

describe("parseSourceMap", () => {
  it("rejects non-JSON, wrong versions, bad shapes and oversized input", () => {
    expect(() => parseSourceMap("not json")).toThrow(SourceMapError);
    expect(() => parseSourceMap('{"version":2,"sources":[],"mappings":""}')).toThrow(/version 3/u);
    expect(() => parseSourceMap('{"version":3,"sources":[1],"mappings":""}')).toThrow(/sources/u);
    expect(() =>
      parseSourceMap('{"version":3,"sources":[],"mappings":""}', { maxBytes: 4 })
    ).toThrow(/limit/u);
    expect(() =>
      parseSourceMap(
        JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, url: "x.map" }] })
      )
    ).toThrow(/embed/u);
  });

  it("accepts the XSSI prefix and indexed maps", () => {
    const simple = { version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" };

    expect(parseSourceMap(`)]}'\n${JSON.stringify(simple)}`).size).toBeGreaterThan(0);
    expect(
      parseSourceMap(
        JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: simple }] })
      ).trace
    ).toBeDefined();
  });
});

describe("collectScriptSourceMaps", () => {
  it("merges metadata and follow-up events per script and ignores invalid rows", () => {
    const table = collectScriptSourceMaps([
      scriptEvent({ script: SCRIPT_URL, sourceMap: `${SCRIPT_URL}.map`, origin: "cdp" }),
      scriptEvent({
        script: SCRIPT_URL,
        sourceMap: `${SCRIPT_URL}.map`,
        origin: "cdp",
        mapError: "timeout"
      }),
      scriptEvent({ script: "https://x.test/inline.js", inlineMap: true, origin: "comment" }),
      scriptEvent({ script: 42, origin: "cdp" })
    ]);

    expect([...table.values()]).toEqual([
      {
        script: SCRIPT_URL,
        sourceMap: `${SCRIPT_URL}.map`,
        inlineMap: false,
        mapError: "timeout"
      },
      { script: "https://x.test/inline.js", inlineMap: true }
    ]);
  });
});

describe("extractEventStack", () => {
  it("reads page error stacks, CDP exceptions, call frames, stackTop and filename", () => {
    const v8 = "Error: x\n    at n (https://x.test/a.js:1:20)";

    expect(extractEventStack(event("error.exception", { stack: v8 }))[0]?.column).toBe(20);
    expect(
      extractEventStack(
        event("error.exception", { exceptionDetails: { exception: { description: v8 } } })
      )[0]?.functionName
    ).toBe("n");
    expect(
      extractEventStack(
        event("error.exception", {
          exceptionDetails: {
            stackTrace: {
              callFrames: [
                { functionName: "n", url: "https://x.test/a.js", lineNumber: 0, columnNumber: 19 }
              ]
            }
          }
        })
      )[0]
    ).toMatchObject({ line: 1, column: 20 });
    expect(
      extractEventStack(
        event("console.entry", { source: "cdp.runtime", stackTop: "n @ https://x.test/a.js:0:19" })
      )[0]
    ).toMatchObject({ line: 1, column: 20 });
    expect(
      extractEventStack(
        event("console.entry", {
          source: "content.injected",
          stackTop: "at n (https://x.test/a.js:1:20)"
        })
      )[0]
    ).toMatchObject({ line: 1, column: 20 });
    expect(
      extractEventStack(event("console.entry", { args: [{ name: "Error", stack: v8 }] }))
    ).toHaveLength(1);
    expect(
      extractEventStack(
        event("error.exception", { filename: "https://x.test/a.js", lineno: 3, colno: 4 })
      )[0]
    ).toMatchObject({ line: 3, column: 4 });
    expect(extractEventStack(event("error.exception", "nope"))).toEqual([]);
  });
});

function scriptEvent(data: Record<string, unknown>): WebBlackboxEvent {
  return event("sys.script", data);
}

function event(type: WebBlackboxEvent["type"], data: unknown): WebBlackboxEvent {
  return { v: 1, sid: "S-1", tab: 1, t: 1, mono: 1, type, id: `E-${type}`, data };
}
