// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { BUILT_IN_PROFILES } from "../shared/profiles/presets.js";
import { isValidHeaderName, isValidMimeType, isValidSelector } from "./fields.js";

describe("chip validators", () => {
  it("accept every value the built-in presets ship with", () => {
    for (const profile of BUILT_IN_PROFILES) {
      const { redaction, network, unmaskSelectors } = profile;

      expect(redaction.blockedSelectors.filter((value) => !isValidSelector(value))).toEqual([]);
      expect(unmaskSelectors.filter((value) => !isValidSelector(value))).toEqual([]);
      expect(redaction.redactHeaders.filter((value) => !isValidHeaderName(value))).toEqual([]);
      expect(network.bodyMimeAllowlist.filter((value) => !isValidMimeType(value))).toEqual([]);
    }
  });

  it("reject malformed values", () => {
    expect(isValidSelector("div[")).toBe(false);
    expect(isValidSelector("input[type=password], .secret")).toBe(true);
    expect(isValidHeaderName("x auth")).toBe(false);
    expect(isValidMimeType("json")).toBe(false);
    expect(isValidMimeType("application/*+json")).toBe(true);
    expect(isValidMimeType("text/*")).toBe(true);
  });
});
