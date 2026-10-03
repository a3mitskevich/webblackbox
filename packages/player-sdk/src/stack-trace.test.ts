import { describe, expect, it } from "vitest";

import { parseCdpStackTop, parseStackLine, parseStackTrace, stripFrameUrl } from "./stack-trace.js";

describe("parseStackTrace", () => {
  it("parses V8 stacks, skipping the message and frames without a script position", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'x')",
      "    at n (https://cdn.x.test/assets/app.min.js?v=3:1:2045)",
      "    at async Object.o [as run] (https://cdn.x.test/assets/app.min.js:1:3010)",
      "    at new Store (https://cdn.x.test/assets/vendor.js:12:7)",
      "    at https://cdn.x.test/assets/app.min.js:1:99",
      "    at Array.map (<anonymous>)",
      "    at eval (eval at boot (https://cdn.x.test/a.js:1:1), <anonymous>:1:5)",
      "    at Promise.then (native)"
    ].join("\n");

    expect(parseStackTrace(stack)).toEqual([
      {
        functionName: "n",
        url: "https://cdn.x.test/assets/app.min.js?v=3",
        line: 1,
        column: 2045,
        raw: "at n (https://cdn.x.test/assets/app.min.js?v=3:1:2045)"
      },
      {
        functionName: "Object.o [as run]",
        url: "https://cdn.x.test/assets/app.min.js",
        line: 1,
        column: 3010,
        raw: "at async Object.o [as run] (https://cdn.x.test/assets/app.min.js:1:3010)"
      },
      {
        functionName: "Store",
        url: "https://cdn.x.test/assets/vendor.js",
        line: 12,
        column: 7,
        raw: "at new Store (https://cdn.x.test/assets/vendor.js:12:7)"
      },
      {
        url: "https://cdn.x.test/assets/app.min.js",
        line: 1,
        column: 99,
        raw: "at https://cdn.x.test/assets/app.min.js:1:99"
      }
    ]);
  });

  it("parses SpiderMonkey and JavaScriptCore stacks", () => {
    const firefox = [
      "n@https://cdn.x.test/app.min.js:1:2045",
      "promise callback*o@https://cdn.x.test/app.min.js:1:3010",
      "@https://cdn.x.test/app.min.js:1:99"
    ].join("\n");
    const safari = [
      "n@https://cdn.x.test/app.min.js:1:2045",
      "global code@https://cdn.x.test/app.min.js:1:99",
      "forEach@[native code]"
    ].join("\n");

    expect(parseStackTrace(firefox).map((frame) => [frame.functionName, frame.column])).toEqual([
      ["n", 2045],
      ["promise callback*o", 3010],
      [undefined, 99]
    ]);
    expect(parseStackTrace(safari).map((frame) => [frame.functionName, frame.line])).toEqual([
      ["n", 1],
      ["global code", 1]
    ]);
  });

  it("caps the number of frames", () => {
    const stack = Array.from(
      { length: 10 },
      (_, index) => `    at f${index} (https://x.test/a.js:1:${index + 1})`
    ).join("\n");

    expect(parseStackTrace(stack, { maxFrames: 3 })).toHaveLength(3);
  });

  it("returns nothing for text without frames", () => {
    expect(parseStackTrace("Error: plain message")).toEqual([]);
    expect(parseStackLine("   ")).toBeNull();
    expect(parseStackLine("contact me@example.com today")).toBeNull();
  });

  it("stays fast on adversarial input", () => {
    const hostile = `at ${"(".repeat(20_000)}${")".repeat(20_000)}\n${"a@".repeat(20_000)}`;
    const startedAt = performance.now();

    parseStackTrace(hostile);

    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("parseCdpStackTop", () => {
  it("converts the recorder's 0-based CDP coordinates to 1-based", () => {
    expect(parseCdpStackTop("n @ https://cdn.x.test/app.min.js:0:2044")).toMatchObject({
      functionName: "n",
      url: "https://cdn.x.test/app.min.js",
      line: 1,
      column: 2045
    });
    expect(parseCdpStackTop("no separator here")).toBeNull();
  });
});

describe("stripFrameUrl", () => {
  it("drops query strings and fragments", () => {
    expect(stripFrameUrl("https://x.test/a.js?v=1#x")).toBe("https://x.test/a.js");
    expect(stripFrameUrl("https://x.test/a.js")).toBe("https://x.test/a.js");
  });
});
