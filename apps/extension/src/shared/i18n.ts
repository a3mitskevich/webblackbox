import type { CaptureMode, FreezeReason } from "@webblackbox/protocol";

import { getChromeApi } from "./chrome-api.js";
import { EN_MESSAGES, type ExtensionMessageKey } from "./locales/en.js";
import { ZH_CN_MESSAGES } from "./locales/zh-cn.js";

export type ExtensionLocale = "en" | "zh-CN";

const EXTENSION_MESSAGES: Record<ExtensionLocale, Record<ExtensionMessageKey, string>> = {
  en: EN_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES
};

export type { ExtensionMessageKey };

export function createExtensionI18n(
  options: {
    pageTitleKey?: ExtensionMessageKey;
  } = {}
) {
  const locale = getExtensionLocale();

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
    formatByteSize: (bytes: number) => formatExtensionByteSize(bytes)
  };
}

export function getExtensionLocale(): ExtensionLocale {
  const chromeApi = getChromeApi();
  const uiLanguage = chromeApi?.i18n?.getUILanguage?.();
  const navigatorLanguage =
    typeof navigator !== "undefined" ? (navigator.language ?? navigator.languages?.[0]) : undefined;

  return normalizeExtensionLocale(uiLanguage ?? navigatorLanguage);
}

export function normalizeExtensionLocale(candidate?: string | null): ExtensionLocale {
  if (typeof candidate !== "string") {
    return "en";
  }

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
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

export function formatExtensionByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  const kb = bytes / 1024;

  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}
