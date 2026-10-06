import { describe, expect, it } from "vitest";

import { isRailTab, parseHashState, serializeHashState } from "./url-hash.js";

describe("parseHashState", () => {
  it("reads time, selection and tab", () => {
    expect(parseHashState("#t=10.89&sel=req:90080.1706&tab=network")).toEqual({
      offsetMs: 10_890,
      selection: { kind: "request", id: "90080.1706" },
      tab: "network"
    });
    expect(parseHashState("sel=evt%3AE-00000012")).toEqual({
      selection: { kind: "event", id: "E-00000012" }
    });
    expect(parseHashState("#sel=act:A-1:extra")).toEqual({
      selection: { kind: "action", id: "A-1:extra" }
    });
  });

  it("ignores invalid and unknown values", () => {
    expect(parseHashState("")).toEqual({});
    expect(parseHashState("#t=-1&sel=foo:1&tab=elsewhere")).toEqual({});
    expect(parseHashState("#t=1e9&sel=evt:&x=1")).toEqual({});
    expect(parseHashState("#t=99999&sel=:abc")).toEqual({});
    expect(parseHashState(`#sel=evt:${"x".repeat(201)}`)).toEqual({});
  });
});

describe("serializeHashState", () => {
  it("round-trips", () => {
    const hash = serializeHashState({
      offsetMs: 10_899,
      selection: { kind: "request", id: "90080.1706" },
      tab: "activity"
    });

    expect(hash).toBe("#t=10.89&sel=req%3A90080.1706&tab=activity");
    expect(parseHashState(hash)).toEqual({
      offsetMs: 10_890,
      selection: { kind: "request", id: "90080.1706" },
      tab: "activity"
    });
  });

  it("drops empty and invalid parts", () => {
    expect(serializeHashState({})).toBe("");
    expect(serializeHashState({ offsetMs: -1 })).toBe("");
    expect(serializeHashState({ offsetMs: 0, tab: "perf" })).toBe("#t=0.00&tab=perf");
  });

  it("validates tabs", () => {
    expect(isRailTab("console")).toBe(true);
    expect(isRailTab("details")).toBe(false);
    expect(isRailTab(3)).toBe(false);
  });
});
