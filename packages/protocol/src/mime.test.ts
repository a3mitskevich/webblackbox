import { describe, expect, it } from "vitest";

import { normalizeMimeType } from "./mime.js";

describe("normalizeMimeType", () => {
  it("keeps a plain media type", () => {
    expect(normalizeMimeType("application/json")).toBe("application/json");
  });

  it("takes the first media type of a header sent twice and joined with a comma", () => {
    expect(normalizeMimeType("application/json, application/json")).toBe("application/json");
    expect(normalizeMimeType("text/plain,application/json")).toBe("text/plain");
  });

  it("drops parameters, including ones of the joined duplicates", () => {
    expect(normalizeMimeType("application/json; charset=utf-8")).toBe("application/json");
    expect(
      normalizeMimeType("application/json;charset=UTF-8, application/json;charset=UTF-8")
    ).toBe("application/json");
    expect(normalizeMimeType('multipart/form-data; boundary="a,b"')).toBe("multipart/form-data");
  });

  it("lower-cases and trims", () => {
    expect(normalizeMimeType("  Application/JSON  ")).toBe("application/json");
    expect(normalizeMimeType("TEXT/HTML ; Charset=UTF-8")).toBe("text/html");
  });

  it("skips empty and malformed members before a valid one", () => {
    expect(normalizeMimeType(", application/json")).toBe("application/json");
    expect(normalizeMimeType("garbage, text/plain")).toBe("text/plain");
  });

  it("returns undefined for missing, empty or malformed values", () => {
    expect(normalizeMimeType(undefined)).toBeUndefined();
    expect(normalizeMimeType(null)).toBeUndefined();
    expect(normalizeMimeType("")).toBeUndefined();
    expect(normalizeMimeType("   ")).toBeUndefined();
    expect(normalizeMimeType(" , ;")).toBeUndefined();
    expect(normalizeMimeType("json")).toBeUndefined();
    expect(normalizeMimeType("application/")).toBeUndefined();
    expect(normalizeMimeType("/json")).toBeUndefined();
    expect(normalizeMimeType("application/json/extra")).toBeUndefined();
    expect(normalizeMimeType("text/plain garbage")).toBeUndefined();
  });
});
