import type { CaptureMode, FreezeReason } from "@webblackbox/protocol";

import { getChromeApi } from "./chrome-api.js";
import EN_MESSAGES from "./locales/en.json" with { type: "json" };
import RU_MESSAGES from "./locales/ru.json" with { type: "json" };
import ZH_CN_MESSAGES from "./locales/zh-CN.json" with { type: "json" };

export type ExtensionLocale = "en" | "ru" | "zh-CN";

/** What the user picked in Options; `auto` follows Chrome's UI language. */
export type ExtensionLocalePreference = "auto" | ExtensionLocale;

export const EXTENSION_LOCALES: readonly ExtensionLocale[] = ["en", "ru", "zh-CN"];

/** Units shown next to number inputs; each has a translated label. */
export type ExtensionUnit = "B" | "MB" | "Hz" | "ms" | "min" | "%";

export const EXTENSION_UNIT_LABEL_KEYS: Record<ExtensionUnit, ExtensionMessageKey> = {
  B: "unitLabelBytes",
  MB: "unitLabelMegabytes",
  Hz: "unitLabelHertz",
  ms: "unitLabelMilliseconds",
  min: "unitLabelMinutes",
  "%": "unitLabelPercent"
};

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

/** `chrome.storage.local` key holding the {@link ExtensionLocalePreference}. */
export const EXTENSION_LOCALE_STORAGE_KEY = "webblackbox.uiLocale";

/** English is the reference dictionary; `locales.test.ts` keeps every other locale's keys equal. */
export type ExtensionMessageKey = keyof typeof EN_MESSAGES;

const EXTENSION_MESSAGES: Record<ExtensionLocale, Record<ExtensionMessageKey, string>> = {
  en: EN_MESSAGES,
  ru: RU_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES
};

export function createExtensionI18n(
  options: {
    pageTitleKey?: ExtensionMessageKey;
    /** Resolved locale (see {@link loadExtensionLocale}); defaults to Chrome's UI language. */
    locale?: ExtensionLocale;
  } = {}
) {
  const locale = options.locale ?? getExtensionLocale();

  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;

    if (options.pageTitleKey) {
      document.title = translateExtensionMessage(locale, options.pageTitleKey);
    }
  }

  return {
    locale,
    t: (key: ExtensionMessageKey, vars?: Record<string, string | number>) =>
      translateExtensionMessage(locale, key, vars),
    formatMode: (mode: CaptureMode) => formatExtensionMode(locale, mode),
    formatFreezeReason: (reason: FreezeReason) => formatExtensionFreezeReason(locale, reason),
    formatRelativeTime: (timestamp: number, now: number) =>
      formatExtensionRelativeTime(locale, timestamp, now),
    formatDuration: (startedAt: number, endedAt: number) =>
      formatExtensionDuration(locale, startedAt, endedAt),
    formatByteSize: (bytes: number) => formatExtensionByteSize(locale, bytes),
    formatNumber: (value: number, fractionDigits?: number) =>
      formatExtensionNumber(locale, value, fractionDigits)
  };
}

export function getExtensionLocale(): ExtensionLocale {
  const chromeApi = getChromeApi();
  const uiLanguage = chromeApi?.i18n?.getUILanguage?.();
  const navigatorLanguage =
    typeof navigator !== "undefined" ? (navigator.language ?? navigator.languages?.[0]) : undefined;

  return normalizeExtensionLocale(uiLanguage ?? navigatorLanguage);
}

/** Anything other than a known locale (missing, tampered, from a newer build) means `auto`. */
export function parseExtensionLocalePreference(value: unknown): ExtensionLocalePreference {
  return EXTENSION_LOCALES.find((locale) => locale === value) ?? "auto";
}

export function resolveExtensionLocale(preference: ExtensionLocalePreference): ExtensionLocale {
  return preference === "auto" ? getExtensionLocale() : preference;
}

/** Reads the stored preference; storage being unavailable or failing falls back to `auto`. */
export async function loadExtensionLocalePreference(): Promise<ExtensionLocalePreference> {
  const storage = getChromeApi()?.storage?.local;

  if (!storage) {
    return "auto";
  }

  try {
    const stored = await storage.get(EXTENSION_LOCALE_STORAGE_KEY);
    return parseExtensionLocalePreference(stored?.[EXTENSION_LOCALE_STORAGE_KEY]);
  } catch {
    return "auto";
  }
}

export async function saveExtensionLocalePreference(
  preference: ExtensionLocalePreference
): Promise<void> {
  const storage = getChromeApi()?.storage?.local;

  if (!storage) {
    throw new Error("chrome.storage.local is unavailable");
  }

  await storage.set({ [EXTENSION_LOCALE_STORAGE_KEY]: preference });
}

/** The locale extension pages render in: the Options choice, else Chrome's UI language. */
export async function loadExtensionLocale(): Promise<ExtensionLocale> {
  return resolveExtensionLocale(await loadExtensionLocalePreference());
}

export function normalizeExtensionLocale(candidate?: string | null): ExtensionLocale {
  if (typeof candidate !== "string") {
    return "en";
  }

  const language = candidate.trim().toLowerCase();

  if (language.startsWith("zh")) {
    return "zh-CN";
  }

  return language === "ru" || language.startsWith("ru-") || language.startsWith("ru_")
    ? "ru"
    : "en";
}

export function translateExtensionMessage(
  locale: ExtensionLocale,
  key: ExtensionMessageKey,
  vars: Record<string, string | number> = {}
): string {
  const template = EXTENSION_MESSAGES[locale][key] ?? EXTENSION_MESSAGES.en[key] ?? key;

  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name] ?? "") : ""
  );
}

export function formatExtensionMode(locale: ExtensionLocale, mode: CaptureMode): string {
  return translateExtensionMessage(locale, mode === "full" ? "modeFull" : "modeLite");
}

export function formatExtensionFreezeReason(locale: ExtensionLocale, reason: FreezeReason): string {
  const key: Record<FreezeReason, ExtensionMessageKey> = {
    error: "freezeReasonError",
    network: "freezeReasonNetwork",
    marker: "freezeReasonMarker",
    perf: "freezeReasonPerf",
    manual: "freezeReasonManual"
  };

  return translateExtensionMessage(locale, key[reason]);
}

export function formatExtensionRelativeTime(
  locale: ExtensionLocale,
  timestamp: number,
  now: number
): string {
  const deltaMs = Math.max(0, now - timestamp);
  const seconds = Math.floor(deltaMs / 1000);

  if (seconds < 60) {
    return translateExtensionMessage(locale, "timeAgoSeconds", {
      value: seconds
    });
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return translateExtensionMessage(locale, "timeAgoMinutes", {
      value: minutes
    });
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return translateExtensionMessage(locale, "timeAgoHours", {
      value: hours
    });
  }

  const days = Math.floor(hours / 24);
  return translateExtensionMessage(locale, "timeAgoDays", {
    value: days
  });
}

export function formatExtensionDuration(
  locale: ExtensionLocale,
  startedAt: number,
  endedAt: number
): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return translateExtensionMessage(locale, "durationMinutesSeconds", {
      minutes,
      seconds
    });
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return translateExtensionMessage(locale, "durationHoursMinutes", {
    hours,
    minutes: remMinutes
  });
}

const numberFormats = new Map<string, Intl.NumberFormat>();

/** Locale digits and separators with a fixed number of decimals (`1,5` in Russian). */
export function formatExtensionNumber(
  locale: ExtensionLocale,
  value: number,
  fractionDigits = 0
): string {
  const cacheKey = `${locale}:${fractionDigits}`;
  let format = numberFormats.get(cacheKey);

  if (!format) {
    format = new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    });
    numberFormats.set(cacheKey, format);
  }

  return format.format(value);
}

export function formatExtensionByteSize(locale: ExtensionLocale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return translateExtensionMessage(locale, "unitBytes", {
      value: formatExtensionNumber(locale, 0)
    });
  }

  if (bytes < BYTES_PER_KB) {
    return translateExtensionMessage(locale, "unitBytes", {
      value: formatExtensionNumber(locale, Math.round(bytes))
    });
  }

  if (bytes < BYTES_PER_MB) {
    return translateExtensionMessage(locale, "unitKilobytes", {
      value: formatExtensionNumber(locale, bytes / BYTES_PER_KB, 1)
    });
  }

  return translateExtensionMessage(locale, "unitMegabytes", {
    value: formatExtensionNumber(locale, bytes / BYTES_PER_MB, 2)
  });
}
