import {
  describePrivacyViolation,
  type PrivacyViolationSubject,
  type RecordingProfileEntry
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

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
