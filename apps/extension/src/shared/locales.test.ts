import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  UI_LOCALES,
  localeFragmentsDir,
  mergeLocaleFragments,
  mergedLocalesDir,
  readLocaleFragments,
  writeMergedLocales,
  type LocaleFragment
} from "../../scripts/lib/locale-fragments.mjs";

const sharedDir = dirname(fileURLToPath(import.meta.url));
const manifestLocalesDir = join(sharedDir, "..", "..", "public", "_locales");

type Dictionary = Record<string, unknown>;

function readJson(path: string): Dictionary {
  return JSON.parse(readFileSync(path, "utf8")) as Dictionary;
}

function placeholdersOf(text: string): string[] {
  return [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
}

/** Every Chrome `_locales/<id>/messages.json`, keyed by folder name. */
function readManifestLocales(): Map<string, Dictionary> {
  return new Map(
    readdirSync(manifestLocalesDir).map((locale) => [
      locale,
      readJson(join(manifestLocalesDir, locale, "messages.json"))
    ])
  );
}

/** The fragments of every feature, keyed by feature, then by locale. */
function readFeatures(): Map<string, Map<string, Record<string, string>>> {
  const features = new Map<string, Map<string, Record<string, string>>>();

  for (const fragment of readLocaleFragments(localeFragmentsDir)) {
    const locales = features.get(fragment.feature) ?? new Map<string, Record<string, string>>();
    locales.set(fragment.locale, fragment.messages);
    features.set(fragment.feature, locales);
  }

  return features;
}

describe("extension UI locale fragments", () => {
  const features = readFeatures();

  it("ships English, Russian and Chinese", () => {
    expect([...UI_LOCALES].sort()).toEqual(["en", "ru", "zh-CN"]);
  });

  it.each([...features.keys()])("%s has a fragment for every locale", (feature) => {
    expect([...(features.get(feature)?.keys() ?? [])].sort()).toEqual([...UI_LOCALES].sort());
  });

  describe.each([...features.keys()])("%s", (feature) => {
    const locales = features.get(feature) ?? new Map<string, Record<string, string>>();
    const reference = locales.get("en") ?? {};

    it.each(UI_LOCALES)("%s has exactly the English key set", (locale) => {
      expect(Object.keys(locales.get(locale) ?? {}).sort()).toEqual(Object.keys(reference).sort());
    });

    it.each(UI_LOCALES)("%s has non-empty strings with the English placeholders", (locale) => {
      const dictionary = locales.get(locale) ?? {};

      for (const [key, english] of Object.entries(reference)) {
        const value = dictionary[key];

        expect(typeof value, `${feature}.${locale}.${key}`).toBe("string");
        expect(String(value).trim(), `${feature}.${locale}.${key}`).not.toBe("");
        expect(placeholdersOf(String(value)), `${feature}.${locale}.${key}`).toEqual(
          placeholdersOf(english)
        );
      }
    });
  });

  it("merges into the dictionaries i18n.ts imports", () => {
    writeMergedLocales();

    for (const locale of UI_LOCALES) {
      const merged = readJson(join(mergedLocalesDir, `${locale}.json`));
      const fromFragments = Object.assign(
        {},
        ...[...features.values()].map((locales) => locales.get(locale) ?? {})
      ) as Dictionary;

      expect(merged).toEqual(fromFragments);
    }
  });
});

describe("mergeLocaleFragments", () => {
  const fragment = (
    feature: string,
    locale: string,
    messages: Record<string, string>
  ): LocaleFragment => ({ file: `${feature}.${locale}.json`, feature, locale, messages });
  const everyLocale = (feature: string, messages: Record<string, string>): LocaleFragment[] =>
    UI_LOCALES.map((locale) => fragment(feature, locale, messages));

  it("joins the features of each locale", () => {
    const merged = mergeLocaleFragments([
      ...everyLocale("popup", { popupTitle: "Popup" }),
      ...everyLocale("sessions", { sessionsTitle: "Sessions" })
    ]);

    expect(Object.keys(merged)).toEqual([...UI_LOCALES]);
    expect(merged.ru).toEqual({ popupTitle: "Popup", sessionsTitle: "Sessions" });
  });

  it("rejects a key defined by two features", () => {
    expect(() =>
      mergeLocaleFragments([
        ...everyLocale("popup", { sharedTitle: "A" }),
        ...everyLocale("sessions", { sharedTitle: "B" })
      ])
    ).toThrow("Message sharedTitle is defined in both popup.en.json and sessions.en.json.");
  });

  it("rejects a feature without a fragment for some locale", () => {
    expect(() =>
      mergeLocaleFragments([fragment("popup", "en", {}), fragment("popup", "ru", {})])
    ).toThrow("Locale fragment popup.zh-CN.json is missing.");
  });
});

describe("readLocaleFragments", () => {
  let dir = "";

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  function fragmentsDir(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), "wb-locales-"));

    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text);
    }

    return dir;
  }

  it("reads <feature>.<locale>.json files", () => {
    const fragments = readLocaleFragments(
      fragmentsDir({ "options-rules.zh-CN.json": '{"optionsRuleAdd":"添加规则"}' })
    );

    expect(fragments).toEqual([
      {
        file: "options-rules.zh-CN.json",
        feature: "options-rules",
        locale: "zh-CN",
        messages: { optionsRuleAdd: "添加规则" }
      }
    ]);
  });

  it.each(["popup.json", "popup.de.json", "Popup.en.json", "en.json"])(
    "rejects the file name %s",
    (name) => {
      expect(() => readLocaleFragments(fragmentsDir({ [name]: "{}" }))).toThrow(
        `Locale fragment ${name} must be named <feature>.<locale>.json`
      );
    }
  );

  it("rejects non-string messages", () => {
    expect(() =>
      readLocaleFragments(fragmentsDir({ "popup.en.json": '{"popupCount":3}' }))
    ).toThrow("Locale fragment popup.en.json: message popupCount must be a string.");
  });

  it("writes only the merged files that changed", () => {
    const source = fragmentsDir(
      Object.fromEntries(UI_LOCALES.map((locale) => [`popup.${locale}.json`, '{"a":"A"}']))
    );
    const outputDir = join(source, "generated");

    expect(writeMergedLocales({ fragmentsDir: source, outputDir })).toHaveLength(3);
    expect(writeMergedLocales({ fragmentsDir: source, outputDir })).toEqual([]);

    writeFileSync(join(source, "popup.ru.json"), '{"a":"Б"}');

    expect(writeMergedLocales({ fragmentsDir: source, outputDir })).toEqual([
      join(outputDir, "ru.json")
    ]);
    expect(readJson(join(outputDir, "ru.json"))).toEqual({ a: "Б" });
  });
});

describe("extension manifest locales", () => {
  const locales = readManifestLocales();
  const reference = locales.get("en") ?? {};

  it("ships manifest strings for every UI locale", () => {
    expect([...locales.keys()].sort()).toEqual(["en", "ru", "zh_CN"]);
  });

  it.each([...locales.keys()])("%s has exactly the English keys, each with a message", (locale) => {
    const dictionary = locales.get(locale) ?? {};

    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(reference).sort());

    for (const [key, entry] of Object.entries(dictionary)) {
      const message = (entry as { message?: unknown } | null)?.message;

      expect(typeof message, `${locale}.${key}`).toBe("string");
      expect(String(message).trim(), `${locale}.${key}`).not.toBe("");
    }
  });
});
