import { describe, expect, it } from "vitest";

import { RAIL_TABS } from "../../core/url-hash.js";
import { PLAYER_LOCALES } from "../../lib/i18n.js";
import { defineFeatureMessages, mergeFeatureCatalog } from "./messages.js";
import { placeholderPanel } from "./placeholder.js";
import {
  collectRailTabs,
  FEATURE_CATALOG,
  PLAYER_FEATURES,
  RAIL_TAB_ORDER,
  RAIL_TAB_REGISTRY
} from "./registry.js";
import { FEATURE_IDS, type PlayerFeature } from "./types.js";

const Panel = placeholderPanel("perf", () => "Perf");

describe("feature registry", () => {
  it("lists every feature folder exactly once", () => {
    expect(PLAYER_FEATURES.map((feature) => feature.id)).toEqual([...FEATURE_IDS]);
  });

  it("registers every rail tab once, in RAIL_TABS order (URL hash and 1…7 keys)", () => {
    expect(RAIL_TAB_ORDER.map((tab) => tab.id)).toEqual([...RAIL_TABS]);
    expect(RAIL_TAB_REGISTRY.get("activity")?.label("ru")).toBe("Хронология");
    expect(RAIL_TAB_REGISTRY.get("realtime")?.label("en")).toBe("Realtime");
  });

  it("rejects a tab registered twice, an unknown tab and an unknown feature", () => {
    const perf: PlayerFeature = {
      id: "perf",
      railTabs: [{ id: "perf", label: () => "Perf", Panel }]
    };

    expect(() => collectRailTabs([perf, { ...perf, id: "tabs" }])).toThrow(/registered twice/);
    expect(() =>
      collectRailTabs([
        { id: "perf", railTabs: [{ id: "nope" as "perf", label: () => "?", Panel }] }
      ])
    ).toThrow(/unknown rail tab "nope"/);
    expect(() => collectRailTabs([{ id: "nope" as "perf" }])).toThrow(/Unknown player feature/);
  });

  it("merges every feature dictionary into one catalog per locale", () => {
    for (const locale of PLAYER_LOCALES) {
      expect(FEATURE_CATALOG.get(locale)?.get("feed.tabLabel")).toBeTruthy();
      expect(FEATURE_CATALOG.get(locale)?.get("network.realtimeTab")).toBeTruthy();
    }

    expect(FEATURE_CATALOG.get("zh-CN")?.get("console.tabLabel")).toBe("控制台");
  });

  it("refuses two dictionaries with the same namespace", () => {
    const strings = { en: { a: "A" }, ru: { a: "А" }, "zh-CN": { a: "甲" } };

    expect(() =>
      mergeFeatureCatalog([
        defineFeatureMessages("feed", strings),
        defineFeatureMessages("feed", strings)
      ])
    ).toThrow(/share the namespace "feed"/);
  });

  it("translates with placeholders and falls back to English", () => {
    const messages = defineFeatureMessages<"hello">("demo", {
      en: { hello: "Hello, {name}" },
      ru: { hello: "Привет, {name}" },
      "zh-CN": {} as { hello: string }
    });

    expect(messages.translate("ru", "hello", { name: "Аня" })).toBe("Привет, Аня");
    expect(messages.translate("zh-CN", "hello", { name: "Li" })).toBe("Hello, Li");
  });
});
