import { describe, expect, it } from "vitest";

import { isTrustedShareOrigin, resolveShareArchiveRequest } from "./share.js";

describe("isTrustedShareOrigin", () => {
  const trusted = ["https://player.example.com", "http://localhost:8787", null, undefined, ""];

  it("trusts listed origins regardless of path", () => {
    expect(isTrustedShareOrigin("http://localhost:8787", trusted)).toBe(true);
    expect(isTrustedShareOrigin("https://player.example.com/share/abc12345", trusted)).toBe(true);
  });

  it("rejects other origins, including look-alike hosts, schemes and ports", () => {
    expect(isTrustedShareOrigin("https://attacker.example", trusted)).toBe(false);
    expect(isTrustedShareOrigin("https://player.example.com.attacker.example", trusted)).toBe(
      false
    );
    expect(isTrustedShareOrigin("http://player.example.com", trusted)).toBe(false);
    expect(isTrustedShareOrigin("http://localhost:9999", trusted)).toBe(false);
  });

  it("rejects invalid input", () => {
    expect(isTrustedShareOrigin("not a url", trusted)).toBe(false);
    expect(isTrustedShareOrigin("", [""])).toBe(false);
  });
});

describe("resolveShareArchiveRequest", () => {
  it("resolves share page URLs to the archive endpoint on the same origin", () => {
    expect(resolveShareArchiveRequest("https://share.example.com/share/abc12345", "")).toEqual({
      shareId: "abc12345",
      baseUrl: "https://share.example.com",
      archiveUrl: "https://share.example.com/api/share/abc12345/archive"
    });
  });

  it("resolves bare share IDs against the fallback server", () => {
    expect(resolveShareArchiveRequest("abc12345", "http://localhost:8787")?.baseUrl).toBe(
      "http://localhost:8787"
    );
  });
});
