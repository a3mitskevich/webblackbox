import {
  describePrivacyViolation,
  type PrivacyViolationSubject,
  type ProfileCancellationInfo,
  type RecordingProfileEntry
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

type ProfileBannerKey =
  | "profileBannerCancelRuleChanged"
  | "profileBannerCancelMissing"
  | "profileBannerCancelEdited"
  | "profileBannerCancelPolicy"
  | "profileBannerCancelUnknown"
  | "profileBannerDowngraded"
  | "profileBannerCapped"
  | "profileBannerUnknownProfile";

type ProfileBannerMessages = {
  t: (key: ProfileBannerKey, values?: Record<string, string | number>) => string;
};

const CANCEL_BANNER_KEYS: Record<string, ProfileBannerKey> = {
  "rule-changed": "profileBannerCancelRuleChanged",
  "profile-missing": "profileBannerCancelMissing",
  "profile-edited": "profileBannerCancelEdited",
  "enterprise-policy": "profileBannerCancelPolicy"
};

type ProfileSummaryMessages = {
  t: (
    key: "summaryProfile" | "summaryProfileRule" | "summaryProfileDowngraded",
    values?: Record<string, string | number>
  ) => string;
};

/** Console/error events a profile replaced with `privacy.violation`; shown in the console panel. */
export function isConsolePrivacyViolation(event: WebBlackboxEvent): boolean {
  const blockedType = describePrivacyViolation(event)?.blockedType ?? "";
  return blockedType.startsWith("console.") || blockedType.startsWith("error.");
}

/** "Hidden by profile: console text" style line for a `privacy.violation` event. */
export function formatPrivacyViolationText(
  event: WebBlackboxEvent,
  formatHiddenByProfile: (subject: PrivacyViolationSubject) => string
): string | null {
  const info = describePrivacyViolation(event);
  return info ? formatHiddenByProfile(info.subject) : null;
}

/** Summary pill text: the profile(s) the session was recorded with, or null for old archives. */
export function formatRecordingProfileSummary(
  entries: readonly RecordingProfileEntry[],
  messages: ProfileSummaryMessages
): string | null {
  if (entries.length === 0) {
    return null;
  }

  return entries
    .map((entry) =>
      entry.downgradedFrom
        ? messages.t("summaryProfileDowngraded", {
            name: entry.name,
            requested: entry.downgradedFrom.name
          })
        : entry.ruleName
          ? messages.t("summaryProfileRule", { name: entry.name, rule: entry.ruleName })
          : messages.t("summaryProfile", { name: entry.name })
    )
    .join(" → ");
}

/**
 * Warnings for the top of the summary: the recording was stopped because its profile changed,
 * an old archive ran with a downgraded profile, or the enterprise policy capped the profile.
 * Empty when the archive recorded exactly what its profile asks for.
 */
export function formatRecordingProfileBanner(
  entries: readonly RecordingProfileEntry[],
  cancellation: ProfileCancellationInfo | null,
  messages: ProfileBannerMessages
): string[] {
  const unknown = messages.t("profileBannerUnknownProfile");
  const cancelKey = cancellation
    ? Object.hasOwn(CANCEL_BANNER_KEYS, cancellation.reason)
      ? CANCEL_BANNER_KEYS[cancellation.reason]
      : "profileBannerCancelUnknown"
    : undefined;
  const cancelLine =
    cancellation && cancelKey
      ? [
          messages.t(cancelKey, {
            started: cancellation.started?.name ?? unknown,
            next: cancellation.next?.name ?? unknown,
            reason: cancellation.reason
          })
        ]
      : [];
  const entryLines = entries.flatMap((entry) => [
    ...(entry.downgradedFrom
      ? [
          messages.t("profileBannerDowngraded", {
            name: entry.name,
            requested: entry.downgradedFrom.name
          })
        ]
      : []),
    ...(entry.enterpriseCapped?.length
      ? [
          messages.t("profileBannerCapped", {
            name: entry.name,
            categories: entry.enterpriseCapped.join(", ")
          })
        ]
      : [])
  ]);

  return [...cancelLine, ...entryLines];
}
