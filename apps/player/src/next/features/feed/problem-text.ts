import type { ProblemGroup } from "@webblackbox/player-sdk";

import type { PlayerLocale } from "../../../lib/i18n.js";
import type { FeedKey, FeedTranslator } from "./messages.js";

const TITLE_MAX = 48;

/** Chromium net errors by family; anything else shows its code. */
const NET_ERROR_LABELS: readonly [RegExp, FeedKey][] = [
  [
    /^ERR_(ADDRESS_INVALID|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|NAME_RESOLUTION_FAILED)$/,
    "netFailedToLoad"
  ],
  [/^ERR_CONNECTION_RESET$/, "netConnectionReset"],
  [/^ERR_CONNECTION_REFUSED$/, "netConnectionRefused"],
  [/^ERR_(CONNECTION_CLOSED|EMPTY_RESPONSE)$/, "netConnectionClosed"],
  [/TIMED_OUT$/, "netTimedOut"],
  [/^ERR_BLOCKED/, "netBlocked"],
  [/^ERR_(CERT_|SSL_)/, "netCertificate"],
  [/PROTOCOL_ERROR$/, "netProtocol"],
  [/^ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED)$/, "netOffline"],
  [/^(ERR_FAILED|failed)$/, "netFailed"]
];

function shorten(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/** "Connection reset" for `ERR_CONNECTION_RESET`; unknown codes stay as they are. */
export function netErrorLabel(code: string, t: FeedTranslator): string {
  const match = NET_ERROR_LABELS.find(([pattern]) => pattern.test(code));
  return match ? t(match[1]) : code;
}

/** The bold part of a problem chip: "401 Unauthorized", "Connection reset", the message. */
export function problemTitle(group: ProblemGroup, t: FeedTranslator): string {
  switch (group.category) {
    case "network":
      return netErrorLabel(group.errorCode ?? "failed", t);
    case "exception":
    case "console":
      return shorten(
        group.message ?? t(group.category === "exception" ? "exception" : "consoleError")
      );
    default:
      return `${group.status ?? ""} ${group.reason ?? ""}`.trim();
  }
}

/** The problem as a phrase inside a sentence ("First auth failure after this click"). */
export function problemPhrase(group: ProblemGroup, t: FeedTranslator): string {
  if (group.category === "auth") {
    return t("authFailure");
  }

  const title = problemTitle(group, t);
  // "Connection reset" reads "connection reset" mid-sentence; messages stay as recorded.
  return group.category === "network"
    ? `${title.charAt(0).toLocaleLowerCase()}${title.slice(1)}`
    : title;
}

/** "4 problems" with the plural form of the locale. */
export function problemsCount(count: number, locale: PlayerLocale, t: FeedTranslator): string {
  const form = new Intl.PluralRules(locale).select(count);
  const key: FeedKey =
    form === "one"
      ? "problemsOne"
      : form === "few"
        ? "problemsFew"
        : form === "many"
          ? "problemsMany"
          : "problemsOther";
  return t(key, { count });
}

const EN_ORDINAL_SUFFIX: Readonly<Record<string, string>> = {
  one: "st",
  two: "nd",
  few: "rd",
  other: "th"
};

/** "2nd" / "2-й" / "第2次" for the visit badge of a route. */
export function formatOrdinal(n: number, locale: PlayerLocale): string {
  if (locale === "ru") {
    return `${n}-й`;
  }

  if (locale === "zh-CN") {
    return `第${n}次`;
  }

  return `${n}${EN_ORDINAL_SUFFIX[new Intl.PluralRules("en", { type: "ordinal" }).select(n)] ?? "th"}`;
}
