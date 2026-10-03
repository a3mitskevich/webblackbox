import { describe, expect, it } from "vitest";

import { normalizeExtensionLocale, translateExtensionMessage } from "./i18n.js";

describe("normalizeExtensionLocale", () => {
  it.each([
    ["ru", "ru"],
    ["ru-RU", "ru"],
    ["ru_RU", "ru"],
    ["zh-CN", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["en-US", "en"],
    ["de", "en"],
    ["rust", "en"],
    [undefined, "en"],
    [null, "en"]
  ] as const)("maps %s to %s", (candidate, expected) => {
    expect(normalizeExtensionLocale(candidate)).toBe(expected);
  });
});

describe("translateExtensionMessage", () => {
  it("fills placeholders in the Russian dictionary", () => {
    expect(
      translateExtensionMessage("ru", "popupStatusRecordingOtherTab", { mode: "Полный", tabId: 7 })
    ).toBe("Идёт запись (Полный) во вкладке 7");
  });
});
