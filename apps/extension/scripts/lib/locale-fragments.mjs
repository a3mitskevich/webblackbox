import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** UI locales of the extension pages; every feature ships one fragment per locale. */
export const UI_LOCALES = ["en", "ru", "zh-CN"];

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where features keep their `<feature>.<locale>.json` dictionary fragments. */
export const localeFragmentsDir = join(appRoot, "src", "shared", "locales");

/** Git-ignored output: one merged `<locale>.json` per locale, imported by `src/shared/i18n.ts`. */
export const mergedLocalesDir = join(localeFragmentsDir, "generated");

const FRAGMENT_FILE_PATTERN = /^([a-z][a-z0-9-]*)\.(en|ru|zh-CN)\.json$/;

/**
 * Reads every `<feature>.<locale>.json` fragment of a directory.
 *
 * @param {string} dir
 * @returns {Array<{ file: string, feature: string, locale: string, messages: Record<string, string> }>}
 */
export function readLocaleFragments(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((file) => {
      const match = FRAGMENT_FILE_PATTERN.exec(file);

      if (!match) {
        throw new Error(
          `Locale fragment ${file} must be named <feature>.<locale>.json with a locale of ${UI_LOCALES.join(", ")}.`
        );
      }

      return {
        file,
        feature: match[1],
        locale: match[2],
        messages: parseFragment(file, readFileSync(join(dir, file), "utf8"))
      };
    });
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseFragment(file, text) {
  const parsed = JSON.parse(text);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Locale fragment ${file} must hold a JSON object of messages.`);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`Locale fragment ${file}: message ${key} must be a string.`);
    }
  }

  return parsed;
}

/**
 * Merges the fragments into one dictionary per locale. Fails when a feature misses a locale or
 * when two features define the same key, so a fragment can never silently override another.
 * Key parity across locales is left to tsc and `locales.test.ts`: a missing translation falls back
 * to English at runtime.
 *
 * @param {ReturnType<typeof readLocaleFragments>} fragments
 * @returns {Record<string, Record<string, string>>}
 */
export function mergeLocaleFragments(fragments) {
  const features = [...new Set(fragments.map((fragment) => fragment.feature))];

  for (const feature of features) {
    for (const locale of UI_LOCALES) {
      if (!fragments.some((entry) => entry.feature === feature && entry.locale === locale)) {
        throw new Error(`Locale fragment ${feature}.${locale}.json is missing.`);
      }
    }
  }

  return Object.fromEntries(
    UI_LOCALES.map((locale) => {
      const owners = new Map();
      const messages = {};

      for (const fragment of fragments.filter((entry) => entry.locale === locale)) {
        for (const [key, value] of Object.entries(fragment.messages)) {
          const owner = owners.get(key);

          if (owner) {
            throw new Error(`Message ${key} is defined in both ${owner} and ${fragment.file}.`);
          }

          owners.set(key, fragment.file);
          messages[key] = value;
        }
      }

      return [locale, messages];
    })
  );
}

/**
 * Writes the merged dictionaries; files whose content did not change are left untouched so a
 * watch build does not rebuild again for them.
 *
 * @param {{ fragmentsDir?: string, outputDir?: string }} [options]
 * @returns {string[]} the files written
 */
export function writeMergedLocales({
  fragmentsDir = localeFragmentsDir,
  outputDir = mergedLocalesDir
} = {}) {
  const merged = mergeLocaleFragments(readLocaleFragments(fragmentsDir));
  const written = [];

  mkdirSync(outputDir, { recursive: true });

  for (const [locale, messages] of Object.entries(merged)) {
    const path = join(outputDir, `${locale}.json`);
    const text = `${JSON.stringify(messages, null, 2)}\n`;

    if (readTextOrNull(path) !== text) {
      writeFileSync(path, text);
      written.push(path);
    }
  }

  return written;
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * tsup plugin: merges the fragments before every build, including each watch-mode rebuild.
 *
 * @returns {{ name: string, buildStart(): void }}
 */
export function mergedLocalesPlugin() {
  return {
    name: "merged-locales",
    buildStart() {
      writeMergedLocales();
    }
  };
}
