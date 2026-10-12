import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";

import {
  DEFAULT_PROFILE_ID,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "./model.js";
import {
  createDefaultProfile,
  DEFAULT_BUILT_IN_PROFILE_ID,
  RECOMMENDED_PROFILE_IDS,
  REMOVED_BUILT_IN_PROFILE_IDS
} from "./presets.js";

/** Name a customised "Default" profile gets once Maximum takes over as the default. */
export const CUSTOMISED_DEFAULT_PROFILE_NAME = "Default (custom)";

const LEGACY_DEFAULT_PROFILE_NAME = "Default";

/**
 * Moves a store of earlier versions to the two built-in profiles (Maximum and Light):
 * - references to removed presets (Full, QA, Full capture) point at Maximum;
 * - the editable Default profile is dropped when it still has the old defaults (its references
 *   point at Maximum), or kept as a user profile named "Default (custom)" when it was customised;
 * - a default selection of Default or a removed preset becomes Maximum;
 * - deleted recommended profiles are listed with the new ids only.
 * User profiles and their rules are kept as they are. Idempotent.
 */
export function migrateStoreToBuiltInPresets(
  store: RecordingProfilesStore
): RecordingProfilesStore {
  const legacyDefault = store.profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID);
  const dropDefault = legacyDefault !== undefined && isPristineLegacyDefaultProfile(legacyDefault);
  const replacedIds = new Set([
    ...REMOVED_BUILT_IN_PROFILE_IDS,
    ...(dropDefault ? [DEFAULT_PROFILE_ID] : [])
  ]);
  const remap = (id: string): string => (replacedIds.has(id) ? DEFAULT_BUILT_IN_PROFILE_ID : id);
  const profiles = store.profiles.flatMap((profile): RecordingProfile[] => {
    if (profile.id !== DEFAULT_PROFILE_ID) {
      return [profile];
    }

    return dropDefault ? [] : [renameCustomisedDefault(profile)];
  });
  const removed = (store.removedRecommendedProfileIds ?? []).filter((id) =>
    RECOMMENDED_PROFILE_IDS.includes(id)
  );
  const defaultProfileId =
    store.defaultProfileId === DEFAULT_PROFILE_ID
      ? DEFAULT_BUILT_IN_PROFILE_ID
      : remap(store.defaultProfileId);
  const withoutRemoved = Object.fromEntries(
    Object.entries(store).filter(([key]) => key !== "removedRecommendedProfileIds")
  ) as RecordingProfilesStore;

  return {
    ...withoutRemoved,
    defaultProfileId,
    profiles,
    rules: store.rules.map((rule): ProfileRule =>
      replacedIds.has(rule.profileId) ? { ...rule, profileId: remap(rule.profileId) } : rule
    ),
    ...(removed.length > 0 ? { removedRecommendedProfileIds: removed } : {})
  };
}

/** A built-in profile id of earlier versions; references to it now mean Maximum. */
export function isRemovedBuiltInProfileId(id: string): boolean {
  return REMOVED_BUILT_IN_PROFILE_IDS.includes(id);
}

/**
 * Whether a stored Default profile is still the one earlier versions created: the same capture
 * settings, whatever its name and description. A v1 capture policy equal to the defaults counts
 * as unset.
 */
export function isPristineLegacyDefaultProfile(profile: RecordingProfile): boolean {
  return (
    stableStringify(comparableDefault(profile)) ===
    stableStringify(comparableDefault(createDefaultProfile()))
  );
}

/** Name, description and a default v1 capture policy say nothing about customisation. */
const IGNORED_DEFAULT_PROFILE_KEYS = new Set(["name", "description", "basePolicy"]);

function comparableDefault(profile: RecordingProfile): Record<string, unknown> {
  const { basePolicy } = profile;
  const keepsBasePolicy =
    basePolicy !== undefined &&
    stableStringify(basePolicy) !== stableStringify(DEFAULT_CAPTURE_POLICY);

  return {
    ...Object.fromEntries(
      Object.entries(profile).filter(([key]) => !IGNORED_DEFAULT_PROFILE_KEYS.has(key))
    ),
    ...(keepsBasePolicy ? { basePolicy } : {})
  };
}

function renameCustomisedDefault(profile: RecordingProfile): RecordingProfile {
  return profile.name === LEGACY_DEFAULT_PROFILE_NAME
    ? { ...profile, name: CUSTOMISED_DEFAULT_PROFILE_NAME }
    : profile;
}

/** JSON with object keys sorted, so stored and freshly built profiles compare by content. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)])
    );
  }

  return value;
}
