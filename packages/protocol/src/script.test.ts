import { describe, expect, it } from "vitest";

import { validateEventData } from "./schemas.js";
import {
  extractSourceMappingUrl,
  readSourceMapHeader,
  resolveSourceMapReference,
  toScriptLocation
} from "./script.js";
import { scriptSourceMapDataSchema } from "./script-schemas.js";

describe("toScriptLocation", () => {
  it("keeps origin and path (hashed bundle names included) and drops query, hash and credentials", () => {
    expect(toScriptLocation("https://user:pw@cdn.x.test/assets/main.4f3a9c2b.js?v=1#frag")).toBe(
      "https://cdn.x.test/assets/main.4f3a9c2b.js"
    );
  });

  it("rejects non-http(s) and oversized URLs", () => {
    expect(toScriptLocation("chrome-extension://abc/content.js")).toBeNull();
    expect(toScriptLocation("not a url")).toBeNull();
    expect(toScriptLocation(`https://x.test/${"a".repeat(3_000)}.js`)).toBeNull();
  });
});

describe("extractSourceMappingUrl", () => {
  it("returns the last sourceMappingURL comment", () => {
    const script = [
      "var a=1;",
      "//# sourceMappingURL=old.js.map",
      "var b=2;",
      "//# sourceMappingURL=app.min.js.map",
      ""
    ].join("\n");

    expect(extractSourceMappingUrl(script)).toBe("app.min.js.map");
  });

  it("accepts the legacy //@ form and CRLF line endings", () => {
    expect(extractSourceMappingUrl("x();\r\n//@ sourceMappingURL=legacy.map\r\n")).toBe(
      "legacy.map"
    );
  });

  it("ignores references that are not whole-line comments or sit outside the tail", () => {
    expect(extractSourceMappingUrl('var s="//# sourceMappingURL=fake.map";')).toBeUndefined();
    expect(
      extractSourceMappingUrl(`//# sourceMappingURL=head.map\n${"x".repeat(9_000)}`)
    ).toBeUndefined();
  });
});

describe("readSourceMapHeader", () => {
  it("prefers SourceMap over X-SourceMap and matches names case-insensitively", () => {
    expect(readSourceMapHeader({ "X-SourceMap": "legacy.map", sourcemap: " app.map " })).toBe(
      "app.map"
    );
    expect(readSourceMapHeader({ "x-sourcemap": "legacy.map" })).toBe("legacy.map");
  });

  it("returns undefined for missing or malformed headers", () => {
    expect(readSourceMapHeader(undefined)).toBeUndefined();
    expect(readSourceMapHeader(["SourceMap", "x"])).toBeUndefined();
    expect(readSourceMapHeader({ SourceMap: 42 })).toBeUndefined();
  });
});

describe("resolveSourceMapReference", () => {
  it("resolves relative references against the script URL", () => {
    expect(
      resolveSourceMapReference("app.js.map", "https://cdn.example.test/assets/app.js")
    ).toEqual({ kind: "remote", url: "https://cdn.example.test/assets/app.js.map" });
  });

  it("detects inline maps and rejects other schemes", () => {
    expect(
      resolveSourceMapReference("data:application/json;base64,e30=", "https://x.test/a.js")?.kind
    ).toBe("inline");
    expect(resolveSourceMapReference("file:///etc/passwd", "https://x.test/a.js")).toBeNull();
    expect(resolveSourceMapReference("javascript:alert(1)", "https://x.test/a.js")).toBeNull();
  });
});

describe("sys.script schema", () => {
  it("accepts metadata and embedded-map payloads", () => {
    expect(
      validateEventData("sys.script", {
        script: "https://x.test/app.js",
        sourceMap: "https://x.test/app.js.map",
        origin: "cdp",
        scriptId: "12"
      }).success
    ).toBe(true);
    expect(
      scriptSourceMapDataSchema.safeParse({
        script: "https://x.test/app.js",
        inlineMap: true,
        origin: "comment",
        map: { contentHash: "abc", size: 10 }
      }).success
    ).toBe(true);
  });

  it("rejects unknown fields and origins", () => {
    expect(
      scriptSourceMapDataSchema.safeParse({ script: "https://x.test/a.js", origin: "guess" })
        .success
    ).toBe(false);
    expect(
      scriptSourceMapDataSchema.safeParse({
        script: "https://x.test/a.js",
        origin: "cdp",
        url: "x"
      }).success
    ).toBe(false);
  });
});
