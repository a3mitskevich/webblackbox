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
    expect(zh.formatMode("lite")).not.toBe(en.formatMode("lite"));
  });
});

describe("locale number formatting", () => {
  it("formats seconds, milliseconds and byte sizes per locale", () => {
    const en = createPlayerI18n("en");
    const ru = createPlayerI18n("ru");

    expect([en.formatSeconds(1250), en.formatMilliseconds(12.34, { fractionDigits: 1 })]).toEqual([
      "1.25s",
      "12.3ms"
    ]);
    expect([ru.formatSeconds(1250), ru.formatMilliseconds(12.34, { fractionDigits: 1 })]).toEqual([
      "1,25 с",
      "12,3 мс"
    ]);
    expect([0, 512, 1536, 5 * 1024 * 1024].map((bytes) => en.formatByteSize(bytes))).toEqual([
      "0 B",
      "512 B",
      "1.5 KB",
      "5.00 MB"
    ]);
    expect(ru.formatByteSize(1536)).toBe("1,5 КБ");
  });

  it("signs deltas and formats ratios as percentages", () => {
    const en = createPlayerI18n("en");

    expect(en.formatNumber(12, { signed: true })).toBe("+12");
    expect(en.formatNumber(-3, { signed: true })).toBe("-3");
    expect(en.formatNumber(0, { signed: true })).toBe("0");
    expect(en.formatNumber(0.2778, { percent: true, signed: true, fractionDigits: 2 })).toBe(
      "+27.78%"
    );
    expect(en.formatNumber(Number.NaN)).toBe("0");
  });

  it("translates known privacy scanner reasons and spells out unknown ones", () => {
    expect(createPlayerI18n("ru").formatSensitiveReason("hashed-value")).toBe(
      "хешированное значение"
    );
    expect(createPlayerI18n("en").formatSensitiveReason("redacted-marker")).toBe("redacted marker");
    expect(createPlayerI18n("ru").formatSensitiveReason("custom-rule")).toBe("custom rule");
  });
});
