import type { NetworkCacheSource, PrivacyViolationSubject } from "@webblackbox/player-sdk";

import EN_MESSAGES from "./locales/en.json" with { type: "json" };
import RU_MESSAGES from "./locales/ru.json" with { type: "json" };
import ZH_CN_MESSAGES from "./locales/zh-CN.json" with { type: "json" };
import type { PointerLaneKind } from "./pointer-overlay.js";
import { readStoredText, writeStoredText } from "./storage.js";

export type PlayerLocale = "en" | "ru" | "zh-CN";

/** Keys of the React player strings; English is the reference dictionary. */
export type NextMessageKey = keyof (typeof EN_MESSAGES)["next"];

type NextMessages = Record<NextMessageKey, string>;

export const PLAYER_LOCALES: readonly PlayerLocale[] = ["en", "ru", "zh-CN"];

type NetworkType =
  | "document"
  | "fetch"
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "text"
  | "other";

type PointerRippleKind = "double" | "right" | "middle" | "hold" | "drag" | "dnd";
type SensitiveReason = "redacted-marker" | "hashed-value" | "sensitive-pattern";

/** Decimals are fixed (min = max); `signed` shows "+" on positives, `percent` takes a ratio. */
export type NumberStyle = { fractionDigits?: number; signed?: boolean; percent?: boolean };

const MS_PER_SECOND = 1000;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

type PlayerMessages = {
  pageTitlePlayer: string;
  localeNames: Record<PlayerLocale, string>;
  modeLite: string;
  modeFull: string;
  unitSeconds: string;
  unitMilliseconds: string;
  unitBytes: string;
  unitKilobytes: string;
  unitMegabytes: string;
  dismiss: string;
  cancel: string;
  load: string;
  copy: string;
  copied: string;
  close: string;
  playbackSpeed: string;
  resizePanels: string;
  exportHar: string;
  share: string;
  networkHeading: string;
  storageHeading: string;
  networkStatusFailed: string;
  copyCurl: string;
  copyFetch: string;
  replayRequest: string;
  passphrase: string;
  regenerate: string;
  download: string;
  uploadNetworkError: string;
  uploadAborted: string;
  uploadResponseNotJsonObject: string;
  uploadInvalidJson: string;
  pointerReasonActionClick: string;
  pointerReasonMove: string;
  networkInitiatorDirect: string;
  networkInitiatorActionNumber: string;
  networkStatusPending: string;
  networkStatusPendingPlain: string;
  networkStatusFromCache: string;
  networkStatusFromCachePlain: string;
  networkStatusNoResponse: string;
  networkStatusNoResponsePlain: string;
  networkCacheSources: Record<NetworkCacheSource, string>;
  networkSizeFailed: string;
  pointerKinds: Record<PointerLaneKind, string>;
  pointerRippleLabels: Record<PointerRippleKind, string>;
  networkTypes: Record<NetworkType, string>;
  privacyHiddenByProfile: string;
  privacySubjects: Record<PrivacyViolationSubject, string>;
  sensitiveReasons: Record<SensitiveReason, string>;
  summaryProfile: string;
  summaryProfileRule: string;
  summaryProfileDowngraded: string;
  profileBannerCancelRuleChanged: string;
  profileBannerCancelMissing: string;
  profileBannerCancelEdited: string;
  profileBannerCancelPolicy: string;
  profileBannerCancelUnknown: string;
  profileBannerDowngraded: string;
  profileBannerCapped: string;
  profileBannerUnknownProfile: string;
  summaryParallelTabs: string;
  summaryParallelTabsDetail: string;
  /** Strings of the React player. */
  next: NextMessages;
};

export const PLAYER_LOCALE_STORAGE_KEY = "webblackbox.player.locale";

/** English is the reference dictionary; `locales.test.ts` keeps every other locale's keys equal. */
const PLAYER_MESSAGES: Record<PlayerLocale, PlayerMessages> = {
  en: EN_MESSAGES,
  ru: RU_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES
};

const numberFormats = new Map<string, Intl.NumberFormat>();

function getNumberFormat(locale: PlayerLocale, style: NumberStyle): Intl.NumberFormat {
  const fractionDigits = style.fractionDigits ?? 0;
  const cacheKey = [locale, fractionDigits, style.signed === true, style.percent === true].join(
    "|"
  );
  let format = numberFormats.get(cacheKey);

  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: style.percent ? "percent" : "decimal",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      signDisplay: style.signed ? "exceptZero" : "auto"
    });
    numberFormats.set(cacheKey, format);
  }

  return format;
}

/** Fills `{placeholders}` from `values`; a missing value becomes an empty string. */
export function interpolate(
  template: string,
  values: Record<string, string | number> = {}
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? "" : String(value);
  });
}

export function resolvePlayerLocale(raw: string | null | undefined): PlayerLocale {
  const normalized = raw?.trim().toLowerCase().replace(/_/g, "-");

  if (!normalized) {
    return "en";
  }

  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-")
  ) {
    return "zh-CN";
  }

  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru";
  }

  return "en";
}

export function detectPlayerLocale(): PlayerLocale {
  try {
    const parsed = new URL(window.location.href);
    const queryLocale = parsed.searchParams.get("lang") ?? parsed.searchParams.get("locale");

    if (queryLocale) {
      return resolvePlayerLocale(queryLocale);
    }
  } catch {
    // Ignore invalid URLs in test contexts.
  }

  const stored = readStoredText(PLAYER_LOCALE_STORAGE_KEY);

  if (stored) {
    return resolvePlayerLocale(stored);
  }

  const preferred =
    typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language) : "en";
  return resolvePlayerLocale(preferred);
}

export function storePlayerLocale(locale: PlayerLocale): void {
  writeStoredText(PLAYER_LOCALE_STORAGE_KEY, locale);
}

export function createPlayerI18n(locale: PlayerLocale = "en") {
  const messages = PLAYER_MESSAGES[locale];

  const t = <K extends keyof PlayerMessages>(
    key: K,
    values?: Record<string, string | number>
  ): string => {
    const value = messages[key];
    return typeof value === "string" ? interpolate(value, values) : "";
  };

  /** A React player string with `{placeholders}` filled in. */
  const tn = (key: NextMessageKey, values?: Record<string, string | number>): string =>
    interpolate(messages.next[key], values);

  const formatNumber = (value: number, style: NumberStyle = {}): string =>
    getNumberFormat(locale, style).format(Number.isFinite(value) ? value : 0);
  /** Playback clock style: seconds with two decimals ("1.25s", "1,25 с"). */
  const formatSeconds = (ms: number, style: NumberStyle = {}): string =>
    t("unitSeconds", {
      value: formatNumber(ms / MS_PER_SECOND, { fractionDigits: 2, ...style })
    });
  const formatMilliseconds = (ms: number, style: NumberStyle = {}): string =>
    t("unitMilliseconds", { value: formatNumber(ms, style) });
  const formatByteSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < BYTES_PER_KB) {
      return t("unitBytes", {
        value: formatNumber(Number.isFinite(bytes) ? Math.round(bytes) : 0)
      });
    }

    if (bytes < BYTES_PER_MB) {
      return t("unitKilobytes", {
        value: formatNumber(bytes / BYTES_PER_KB, { fractionDigits: 1 })
      });
    }

    return t("unitMegabytes", { value: formatNumber(bytes / BYTES_PER_MB, { fractionDigits: 2 }) });
  };
  /** Known privacy-scanner reasons are translated; anything else is shown as words. */
  const formatSensitiveReason = (reason: string): string =>
    Object.hasOwn(messages.sensitiveReasons, reason)
      ? messages.sensitiveReasons[reason as SensitiveReason]
      : reason.replaceAll("-", " ");

  const formatMode = (mode: string): string => {
    if (mode === "lite") {
      return messages.modeLite;
    }

    if (mode === "full") {
      return messages.modeFull;
    }

    return mode.toUpperCase();
  };

  const formatPointerKind = (kind: PointerLaneKind): string => messages.pointerKinds[kind];
  const formatPointerRipple = (kind: string): string | null =>
    kind in messages.pointerRippleLabels
      ? messages.pointerRippleLabels[kind as PointerRippleKind]
      : null;
  const formatNetworkType = (type: NetworkType): string => messages.networkTypes[type];
  const formatHiddenByProfile = (subject: PrivacyViolationSubject): string =>
    t("privacyHiddenByProfile", { what: messages.privacySubjects[subject] });
  const formatNetworkInitiatorActionNumber = (index: string): string =>
    t("networkInitiatorActionNumber", { index });

  return {
    locale,
    messages,
    t,
    tn,
    formatMode,
    formatPointerKind,
    formatPointerRipple,
    formatNetworkType,
    formatHiddenByProfile,
    formatNetworkInitiatorActionNumber,
    formatNumber,
    formatSeconds,
    formatMilliseconds,
    formatByteSize,
    formatSensitiveReason
  };
}

export function applyPlayerDocumentLocale(locale: PlayerLocale): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = locale;
  document.title = createPlayerI18n(locale).messages.pageTitlePlayer;
}
export type PlayerI18n = ReturnType<typeof createPlayerI18n>;
