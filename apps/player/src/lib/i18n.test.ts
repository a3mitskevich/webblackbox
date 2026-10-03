import { describe, expect, it } from "vitest";

import { createPlayerI18n, resolvePlayerLocale } from "./i18n.js";

describe("resolvePlayerLocale", () => {
  it.each([
    ["ru", "ru"],
    ["ru-RU", "ru"],
    ["RU_ru", "ru"],
    ["zh", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["en-US", "en"],
    ["de", "en"],
    ["rust", "en"],
    ["", "en"],
    [null, "en"]
  ])("maps %s to %s", (raw, expected) => {
    expect(resolvePlayerLocale(raw)).toBe(expected);
  });
});

describe("createPlayerI18n", () => {
  it("formats modes and selections from the dictionary of each locale", () => {
    const ru = createPlayerI18n("ru");
    const zh = createPlayerI18n("zh-CN");
    const en = createPlayerI18n("en");

    expect([ru.formatMode("lite"), ru.formatMode("full"), ru.formatMode("custom")]).toEqual([
      "Лёгкий",
      "Полный",
      "CUSTOM"
    ]);
    expect(ru.formatSelection("request", "R-1")).toBe("запрос R-1");
    expect(zh.formatSelection("action", "A-1")).toBe("动作 A-1");
    expect(en.formatSelection("event", "E-1")).toBe("event E-1");
    expect(ru.formatStatusPanel("network", ru.formatSelection("request", "R-1"))).toBe(
      "Панель «Сеть» | запрос R-1"
    );
  });
});
