import type { RecorderConfig } from "@webblackbox/protocol";

import type { ProfileCancelNotice, ProfileCancelReason } from "../shared/messages.js";
import {
  toArchivedProfileInfo,
  type ArchivedProfileInfo,
  type ProfileSelection
} from "../shared/profiles/resolve.js";

/** A recording profile as a session runs it. */
export type SessionProfileSnapshot = {
  selection: ProfileSelection;
  /** Recorder config the profile renders to, before enterprise policy. */
  profileConfig: RecorderConfig;
  /** What the recorder actually runs: after enterprise policy. */
  effectiveConfig: RecorderConfig;
};

export type ProfileCancelTrigger = "navigation" | "page-loaded";

/** What `meta.config.profileCancel` records in the archive. */
export type ProfileCancellation = {
  reason: ProfileCancelReason;
  trigger: ProfileCancelTrigger;
  at: number;
  started: ArchivedProfileInfo;
  /** The profile the page would now record with; absent when no profile exists. */
  next?: ArchivedProfileInfo;
};

/**
 * Whether the profile a session runs differs from the one it started with, and why. A different
 * rule that picks the same profile with the same settings is no change. Configs are compared by
 * value, not key order.
 */
export function detectProfileChange(input: {
  started: SessionProfileSnapshot;
  next: SessionProfileSnapshot | null;
  /** The started profile is still in the catalog (not deleted). */
  startedProfileExists: boolean;
}): ProfileCancelReason | null {
  const { started, next } = input;

  if (!next || !input.startedProfileExists) {
    return "profile-missing";
  }

  if (next.selection.profile.id !== started.selection.profile.id) {
    return "rule-changed";
  }

  if (!isSameValue(next.profileConfig, started.profileConfig)) {
    return "profile-edited";
  }

  return isSameValue(next.effectiveConfig, started.effectiveConfig) ? null : "enterprise-policy";
}

export function buildProfileCancellation(input: {
  reason: ProfileCancelReason;
  trigger: ProfileCancelTrigger;
  at: number;
  started: ProfileSelection;
  next: ProfileSelection | null;
}): ProfileCancellation {
  return {
    reason: input.reason,
    trigger: input.trigger,
    at: input.at,
    started: toArchivedProfileInfo(input.started),
    ...(input.next ? { next: toArchivedProfileInfo(input.next) } : {})
  };
}

export function toProfileCancelNotice(cancellation: ProfileCancellation): ProfileCancelNotice {
  return {
    reason: cancellation.reason,
    at: cancellation.at,
    startedName: cancellation.started.name,
    ...(cancellation.next ? { nextName: cancellation.next.name } : {})
  };
}

function isSameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** JSON with object keys sorted, so equal configs built in a different order compare equal. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        )
      : entry
  );
}
