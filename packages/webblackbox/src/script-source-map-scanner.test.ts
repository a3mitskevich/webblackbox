import { describe, expect, it, vi } from "vitest";

import {
  startScriptSourceMapScanner,
  type ScriptSourceMapReference
} from "./script-source-map-scanner.js";

const ORIGIN = "https://app.test";

type FakeResponse = { ok: boolean; headers: Record<string, string>; body: string };

function createFetch(responses: Record<string, FakeResponse>) {
  return vi.fn(async (url: string) => {
    const response = responses[url] ?? { ok: false, headers: {}, body: "" };
    return {
      ok: response.ok,
      headers: { get: (name: string) => response.headers[name.toLowerCase()] ?? null },
      text: async () => response.body
    };
  });
}

function scan(options: {
  scripts?: string[];
  resources?: Array<{ name: string; initiatorType: string }>;
  responses: Record<string, FakeResponse>;
  maxScripts?: number;
  maxScriptBytes?: number;
}) {
  const emitted: ScriptSourceMapReference[] = [];
  const fetchImpl = createFetch(options.responses);
  const stop = startScriptSourceMapScanner({
    emit: (reference) => emitted.push(reference),
    fetch: fetchImpl,
    origin: ORIGIN,
    document: {
      scripts: (options.scripts ?? []).map((src) => ({ src })) as unknown as Document["scripts"]
    },
    performance: {
      getEntriesByType: () => (options.resources ?? []) as unknown as PerformanceEntryList
    },
    ...(options.maxScripts !== undefined ? { maxScripts: options.maxScripts } : {}),
    ...(options.maxScriptBytes !== undefined ? { maxScriptBytes: options.maxScriptBytes } : {})
  });

  return { emitted, fetchImpl, stop };
}

describe("startScriptSourceMapScanner", () => {
  it("reports header and comment references of same-origin scripts once each", async () => {
    const { emitted, fetchImpl } = scan({
      scripts: [`${ORIGIN}/a.js`, `${ORIGIN}/b.js#x`, "https://cdn.other.test/c.js", ""],
      resources: [
        { name: `${ORIGIN}/a.js`, initiatorType: "script" },
        { name: `${ORIGIN}/style.css`, initiatorType: "link" }
      ],
      responses: {
        [`${ORIGIN}/a.js`]: { ok: true, headers: { sourcemap: "/maps/a.js.map" }, body: "x" },
        [`${ORIGIN}/b.js`]: {
          ok: true,
          headers: {},
          body: "var b=1;\n//# sourceMappingURL=b.js.map\n"
        }
      }
    });

    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(emitted).toEqual([
      { url: `${ORIGIN}/a.js`, sourceMapUrl: "/maps/a.js.map", origin: "header" },
      { url: `${ORIGIN}/b.js`, sourceMapUrl: "b.js.map", origin: "comment" }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(`${ORIGIN}/a.js`, {
      cache: "force-cache",
      credentials: "same-origin"
    });
  });

  it("skips failed, oversized and map-less scripts and honours the script cap", async () => {
    const { emitted, fetchImpl } = scan({
      scripts: [`${ORIGIN}/fail.js`, `${ORIGIN}/big.js`, `${ORIGIN}/plain.js`, `${ORIGIN}/late.js`],
      maxScripts: 3,
      maxScriptBytes: 10,
      responses: {
        [`${ORIGIN}/big.js`]: {
          ok: true,
          headers: { "content-length": "999" },
          body: "//# sourceMappingURL=big.js.map"
        },
        [`${ORIGIN}/plain.js`]: { ok: true, headers: {}, body: "var x;" },
        [`${ORIGIN}/late.js`]: {
          ok: true,
          headers: { sourcemap: "late.js.map" },
          body: ""
        }
      }
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(emitted).toEqual([]);
  });

  it("stops emitting once stopped", async () => {
    const { emitted, fetchImpl, stop } = scan({
      scripts: [`${ORIGIN}/a.js`],
      responses: {
        [`${ORIGIN}/a.js`]: { ok: true, headers: { sourcemap: "a.js.map" }, body: "" }
      }
    });

    stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });
});
