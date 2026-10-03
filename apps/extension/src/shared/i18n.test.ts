import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXTENSION_LOCALE_STORAGE_KEY,
  createExtensionI18n,
  formatExtensionByteSize,
  loadExtensionLocale,
  loadExtensionLocalePreference,
  normalizeExtensionLocale,
  parseExtensionLocalePreference,
  saveExtensionLocalePreference,
  translateExtensionMessage
} from "./i18n.js";

function installChrome(options: { uiLanguage?: string; stored?: unknown; getFails?: boolean }) {
  const data: Record<string, unknown> =
    options.stored === undefined ? {} : { [EXTENSION_LOCALE_STORAGE_KEY]: options.stored };
  const get = vi.fn(async () => {
    if (options.getFails) {
      throw new Error("storage unavailable");
    }

    return { ...data };
  });
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(data, items);
  });

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      i18n: { getUILanguage: () => options.uiLanguage ?? "en-US" },
      storage: { local: { get, set } }
    }
  });

  return { data, get, set };
}

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

describe("locale preference", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });

  it.each([
    ["en", "en"],
    ["ru", "ru"],
    ["zh-CN", "zh-CN"],
    ["auto", "auto"],
    ["zh", "auto"],
    ["", "auto"],
    [42, "auto"],
    [undefined, "auto"]
  ])("parses %s as %s", (value, expected) => {
    expect(parseExtensionLocalePreference(value)).toBe(expected);
  });

  it("uses the stored choice over Chrome's language", async () => {
    installChrome({ uiLanguage: "zh-CN", stored: "ru" });

    await expect(loadExtensionLocalePreference()).resolves.toBe("ru");
    await expect(loadExtensionLocale()).resolves.toBe("ru");
  });

  it("follows Chrome's language for Auto, a missing or a broken value", async () => {
    installChrome({ uiLanguage: "ru-RU", stored: "auto" });
    await expect(loadExtensionLocale()).resolves.toBe("ru");

    installChrome({ uiLanguage: "ru-RU" });
    await expect(loadExtensionLocale()).resolves.toBe("ru");

    installChrome({ uiLanguage: "zh-CN", stored: { locale: "en" } });
    await expect(loadExtensionLocale()).resolves.toBe("zh-CN");
  });

  it("falls back to Auto when storage fails or is missing", async () => {
    installChrome({ uiLanguage: "ru", getFails: true });
    await expect(loadExtensionLocalePreference()).resolves.toBe("auto");
    await expect(loadExtensionLocale()).resolves.toBe("ru");

    Reflect.deleteProperty(globalThis, "chrome");
    await expect(loadExtensionLocalePreference()).resolves.toBe("auto");
  });

  it("stores the preference under its key", async () => {
    const chrome = installChrome({});

    await saveExtensionLocalePreference("zh-CN");

    expect(chrome.set).toHaveBeenCalledWith({ [EXTENSION_LOCALE_STORAGE_KEY]: "zh-CN" });
    await expect(loadExtensionLocalePreference()).resolves.toBe("zh-CN");
  });
});

describe("locale formatting", () => {
  it.each([
    ["en", [0, 512, 1536, 5 * 1024 * 1024], ["0 B", "512 B", "1.5 KB", "5.00 MB"]],
    ["ru", [0, 512, 1536, 5 * 1024 * 1024], ["0 Б", "512 Б", "1,5 КБ", "5,00 МБ"]],
    ["zh-CN", [0, 512, 1536, 5 * 1024 * 1024], ["0 B", "512 B", "1.5 KB", "5.00 MB"]]
  ] as const)("formats byte sizes in %s", (locale, sizes, expected) => {
    expect(sizes.map((bytes) => formatExtensionByteSize(locale, bytes))).toEqual(expected);
  });

  it("groups digits and uses the locale decimal separator", () => {
    const ru = createExtensionI18n({ locale: "ru" });
    const en = createExtensionI18n({ locale: "en" });

    expect(ru.formatNumber(1843)).toBe(new Intl.NumberFormat("ru").format(1843));
    expect(ru.formatNumber(2.25, 1)).toMatch(/^2,[23]$/);
    expect(en.formatNumber(1843)).toBe("1,843");
    expect(en.formatNumber(2, 1)).toBe("2.0");
  });
});
