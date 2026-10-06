// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { BUILT_IN_PROFILES } from "../shared/profiles/presets.js";
import {
  helpTip,
  installTooltipDismiss,
  isValidHeaderName,
  isValidMimeType,
  isValidSelector
} from "./fields.js";

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

describe("help tooltips", () => {
  it("hide on Escape while focused and come back once focus leaves", () => {
    const root = document.createElement("div");
    const tip = helpTip("More about Ring buffer", "Keeps the last N minutes.");
    const other = document.createElement("button");
    root.append(tip, other);
    document.body.append(root);
    installTooltipDismiss(root);
    const button = tip.querySelector<HTMLButtonElement>("button");

    button?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(tip.classList.contains("wb-help--dismissed")).toBe(true);

    other.focus();

    expect(tip.classList.contains("wb-help--dismissed")).toBe(false);
    root.remove();
  });
});
