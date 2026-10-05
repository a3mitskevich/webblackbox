import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";

import type { ProfileCancelNotice, ProfileCancelReason } from "../shared/messages.js";
import {
  DEFAULT_PROFILE_ID,
  PROFILES_STORAGE_KEY,
  type ProfileRule,
  type RecordingProfile
} from "../shared/profiles/model.js";
import {
  AUTO_PROFILE_ID,
  isExtendedCaptureProfile,
  toArchivedProfileInfo,
  type ArchivedProfileInfo,
  type ProfileSelection
} from "../shared/profiles/resolve.js";
import { collectPageSignalRequest } from "../shared/profiles/rules.js";
import type { ProfilesState } from "../shared/profiles/storage.js";

/** A recording profile as a session runs it. */
export type SessionProfileSnapshot = {
  selection: ProfileSelection;
  /** Recorder config the profile renders to, before enterprise policy. */
  profileConfig: RecorderConfig;
  /** What the recorder actually runs: after enterprise policy. */
  effectiveConfig: RecorderConfig;
};

/** What a recorder config sets; v1 option keys stored next to them are not profile settings. */
const RECORDER_CONFIG_KEYS = [
  ...new Set([...Object.keys(DEFAULT_RECORDER_CONFIG), "capturePolicy"])
] as Array<keyof RecorderConfig>;

export type ProfileCancelTrigger = "navigation" | "page-loaded" | "settings-changed";

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

  if (
    !isSameRunningConfig(next.profileConfig, started.profileConfig) ||
    // The service worker also reads body filters and other settings from the profile itself. The
    // legacy Default is derived from v1 options, which the config comparison already covers.
    (!started.selection.legacy &&
      !isSameValue(
        toProfileSettings(next.selection.profile),
        toProfileSettings(started.selection.profile)
      ))
  ) {
    return "profile-edited";
  }

  return isSameRunningConfig(next.effectiveConfig, started.effectiveConfig)
    ? null
    : "enterprise-policy";
}

/**
 * Title, meta tags and selectors are only reliable once the page has loaded: while it loads, a
 * rule that reads them may not match yet, which would look like a profile change. Such a check
 * waits for the `page-loaded` one. Rules that read only the URL are checked at once.
 */
export function shouldDeferProfileCheck(input: {
  trigger: ProfileCancelTrigger;
  tabLoading: boolean;
  rules: readonly ProfileRule[];
}): boolean {
  if (input.trigger === "page-loaded" || !input.tabLoading) {
    return false;
  }

  const request = collectPageSignalRequest(input.rules);
  return request.needsTitle || request.metaNames.length > 0 || request.selectors.length > 0;
}

/**
 * Storage writes that can change the profile a running recording uses: the profiles store, the
 * v1 options behind the legacy Default profile, and the managed enterprise policy.
 */
export function isProfileSettingsChange(
  changes: Record<string, unknown>,
  areaName: string,
  keys: { legacyOptionsKey: string }
): boolean {
  if (areaName === "managed") {
    return true;
  }

  return (
    areaName === "local" &&
    (Object.hasOwn(changes, PROFILES_STORAGE_KEY) || Object.hasOwn(changes, keys.legacyOptionsKey))
  );
}

/**
 * The started profile as the store holds it now, for a check that cannot match the rules (the page
 * could not be read): deleting, editing or capping it still cancels. Null when it was deleted.
 */
export function reselectStartedProfile(
  started: ProfileSelection,
  state: ProfilesState
): ProfileSelection | null {
  const profile = state.catalog.find((entry) => entry.id === started.profile.id);

  if (!profile) {
    return null;
  }

  const legacy = state.legacy && profile.id === DEFAULT_PROFILE_ID;
  return { ...started, profile, legacy, extended: !legacy && isExtendedCaptureProfile(profile) };
}

/**
 * What later checks re-run for a session: the chosen profile id, or `auto` when that id did not
 * exist at Start (a stale popup choice) and the rules picked the profile instead.
 */
export function toSessionProfileRequest(request: string, selection: ProfileSelection): string {
  return selection.source === "explicit" ? request : AUTO_PROFILE_ID;
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

/** A profile's settings: renaming it or rewording its description changes nothing recorded. */
function toProfileSettings(profile: RecordingProfile): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) => key !== "name" && key !== "description")
  );
}

function isSameRunningConfig(left: RecorderConfig, right: RecorderConfig): boolean {
  return stableStringify(toRunningConfig(left)) === stableStringify(toRunningConfig(right));
}

/**
 * The part of a config the recorder runs: recorder config keys only (the legacy Default path
 * spreads the whole v1 options record, `optionsVersion` and `performanceBudget` included), with
 * the capture policy's redaction replaced by the config's, as the session start does.
 */
function toRunningConfig(config: RecorderConfig): Record<string, unknown> {
  const picked = Object.fromEntries(RECORDER_CONFIG_KEYS.map((key) => [key, config[key]]));

  return {
    ...picked,
    capturePolicy: config.capturePolicy
      ? { ...config.capturePolicy, redaction: config.redaction }
      : undefined
  };
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
