import { useMemo } from "react";

import { interpolate, PLAYER_LOCALES, type PlayerLocale } from "../../lib/i18n.js";
import { usePlayerState } from "../context.js";

type MessageValues = Record<string, string | number>;

/** English is the reference dictionary: the other locales must have exactly its keys. */
export type FeatureDictionaries<K extends string> = Record<PlayerLocale, Record<K, string>>;

export type FeatureTranslator<K extends string> = (key: K, values?: MessageValues) => string;

/** A feature's strings in every locale, with a typed translator per locale. */
export type FeatureMessages<K extends string> = {
  /** The feature folder (namespace in the merged catalog). */
  feature: string;
  dictionaries: FeatureDictionaries<K>;
  translate(locale: PlayerLocale, key: K, values?: MessageValues): string;
};

// The registry holds features with different key sets.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- erased key type, see above
export type AnyFeatureMessages = FeatureMessages<any>;

/**
 * Declares a feature's dictionaries (`features/<feature>/locales/{en,ru,zh-CN}.json`). The key
 * type comes from the English file, so `t("…")` is checked at compile time; the locale parity
 * test checks that RU and 中文 have the same keys and placeholders.
 */
export function defineFeatureMessages<K extends string>(
  feature: string,
  dictionaries: FeatureDictionaries<K>
): FeatureMessages<K> {
  return {
    feature,
    dictionaries,
    translate(locale, key, values) {
      const text = dictionaries[locale][key] ?? dictionaries.en[key];
      return interpolate(text, values);
    }
  };
}

/**
 * The strings of one feature in the current locale. Switching the language re-renders the
 * consumers in place (no reload), like the core strings.
 */
export function useFeatureI18n<K extends string>(
  messages: FeatureMessages<K>
): FeatureTranslator<K> {
  const locale = usePlayerState((state) => state.locale);
  return useMemo(
    () => (key: K, values?: MessageValues) => messages.translate(locale, key, values),
    [messages, locale]
  );
}

/** `locale → "<feature>.<key>" → text`: every feature dictionary merged at startup. */
export type FeatureCatalog = ReadonlyMap<PlayerLocale, ReadonlyMap<string, string>>;

export function mergeFeatureCatalog(messages: readonly AnyFeatureMessages[]): FeatureCatalog {
  const namespaces = messages.map((entry) => entry.feature);
  const duplicate = namespaces.find((name, index) => namespaces.indexOf(name) !== index);

  if (duplicate) {
    throw new Error(`Two feature dictionaries share the namespace "${duplicate}".`);
  }

  return new Map(
    PLAYER_LOCALES.map((locale) => [
      locale,
      new Map(
        messages.flatMap((entry) =>
          Object.entries(entry.dictionaries[locale] as Record<string, string>).map(
            ([key, text]): [string, string] => [`${entry.feature}.${key}`, text]
          )
        )
      )
    ])
  );
}
