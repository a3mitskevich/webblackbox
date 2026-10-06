import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const localesDir = join(dirname(fileURLToPath(import.meta.url)), "locales");

/** Flattens nested dictionaries (e.g. `panels.network`) to dotted key → leaf value. */
function flatten(value: unknown, prefix = ""): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Map([[prefix, value]]);
  }

  return new Map(
    Object.entries(value).flatMap(([key, child]) => [
      ...flatten(child, prefix ? `${prefix}.${key}` : key)
    ])
  );
}

function placeholdersOf(text: string): string[] {
  return [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
}

const locales = new Map(
  readdirSync(localesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [
      file.replace(/\.json$/, ""),
      flatten(JSON.parse(readFileSync(join(localesDir, file), "utf8")))
    ])
);
const reference = locales.get("en") ?? new Map<string, unknown>();

describe("player locales", () => {
  it("ships English, Russian and Chinese dictionaries", () => {
    expect([...locales.keys()].sort()).toEqual(["en", "ru", "zh-CN"]);
  });

  it.each([...locales.keys()])("%s has exactly the English key set", (locale) => {
    expect([...(locales.get(locale)?.keys() ?? [])].sort()).toEqual([...reference.keys()].sort());
  });

  it.each([...locales.keys()])(
    "%s has non-empty strings with the English placeholders",
    (locale) => {
      const dictionary = locales.get(locale) ?? new Map<string, unknown>();

      for (const [key, english] of reference) {
        const value = dictionary.get(key);

        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(String(value).trim(), `${locale}.${key}`).not.toBe("");
        expect(placeholdersOf(String(value)), `${locale}.${key}`).toEqual(
          placeholdersOf(String(english))
        );
      }
    }
  );
});

// Per-feature dictionaries of the React player: `src/next/features/<feature>/locales/*.json`.
const featuresDir = join(dirname(fileURLToPath(import.meta.url)), "..", "next", "features");
const featureLocaleDirs = readdirSync(featuresDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(featuresDir, entry.name, "locales"))
  .filter((dir) => {
    try {
      return readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  });

describe("feature locales", () => {
  it("finds the feature dictionaries", () => {
    expect(featureLocaleDirs.length).toBeGreaterThanOrEqual(6);
  });

  it.each(featureLocaleDirs.map((dir) => [dir.split(/[\\/]/).at(-2) ?? dir, dir]))(
    "%s ships EN/RU/中文 with the English keys and placeholders",
    (_feature, dir) => {
      const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
      expect(files.sort()).toEqual(["en.json", "ru.json", "zh-CN.json"]);

      const read = (locale: string) =>
        flatten(JSON.parse(readFileSync(join(dir, `${locale}.json`), "utf8")));
      const english = read("en");

      for (const locale of ["ru", "zh-CN"]) {
        const dictionary = read(locale);
        expect([...dictionary.keys()].sort(), locale).toEqual([...english.keys()].sort());

        for (const [key, text] of english) {
          const value = dictionary.get(key);
          expect(typeof value, `${locale}.${key}`).toBe("string");
          expect(String(value).trim(), `${locale}.${key}`).not.toBe("");
          expect(placeholdersOf(String(value)), `${locale}.${key}`).toEqual(
            placeholdersOf(String(text))
          );
        }
      }
    }
  );
});
