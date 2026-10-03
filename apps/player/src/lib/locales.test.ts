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
  it("ships English and Chinese dictionaries", () => {
    expect([...locales.keys()].sort()).toEqual(["en", "zh-CN"]);
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
