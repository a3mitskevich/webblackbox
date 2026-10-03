import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sharedDir = dirname(fileURLToPath(import.meta.url));
const uiLocalesDir = join(sharedDir, "locales");
const manifestLocalesDir = join(sharedDir, "..", "..", "public", "_locales");

type Dictionary = Record<string, unknown>;

function readJson(path: string): Dictionary {
  return JSON.parse(readFileSync(path, "utf8")) as Dictionary;
}

function placeholdersOf(text: string): string[] {
  return [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
}

/** Every UI dictionary, keyed by locale id (the file name). */
function readUiLocales(): Map<string, Dictionary> {
  return new Map(
    readdirSync(uiLocalesDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => [file.replace(/\.json$/, ""), readJson(join(uiLocalesDir, file))])
  );
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

describe("extension UI locales", () => {
  const locales = readUiLocales();
  const reference = locales.get("en") ?? {};

  it("ships English, Russian and Chinese dictionaries", () => {
    expect([...locales.keys()].sort()).toEqual(["en", "ru", "zh-CN"]);
  });

  it.each([...locales.keys()])("%s has exactly the English key set", (locale) => {
    expect(Object.keys(locales.get(locale) ?? {}).sort()).toEqual(Object.keys(reference).sort());
  });

  it.each([...locales.keys()])(
    "%s has non-empty strings with the English placeholders",
    (locale) => {
      const dictionary = locales.get(locale) ?? {};

      for (const [key, english] of Object.entries(reference)) {
        const value = dictionary[key];

        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(String(value).trim(), `${locale}.${key}`).not.toBe("");
        expect(placeholdersOf(String(value)), `${locale}.${key}`).toEqual(
          placeholdersOf(String(english))
        );
      }
    }
  );
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
