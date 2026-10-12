import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";

import { isDefaultLocalDataSettings } from "./local-data.js";
import {
  DEFAULT_PROFILE_ID,
  type ProfileLocalDataSettings,
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
/** Replaces the old Default description, which no longer holds for the kept profile. */
export const CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION =
  "Your customised Default profile from an earlier version.";

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
 * Whether a stored Default profile still records as the one earlier versions created, whatever its
 * name and description. Settings are compared by effect, so a Default that only went through a
 * form or a v1 options save is still pristine: a setting equal to its default counts as unset (see
 * `effectiveDefaultSettings`).
 */
export function isPristineLegacyDefaultProfile(profile: RecordingProfile): boolean {
  return (
    stableStringify(effectiveDefaultSettings(profile)) ===
    stableStringify(effectiveDefaultSettings(createDefaultProfile()))
  );
}

/** Name and description say nothing about customisation. */
const IGNORED_DEFAULT_PROFILE_KEYS = new Set(["name", "description"]);

/** Optional redaction settings and the value that means "unset". */
const DEFAULT_REDACTION_OPTIONS: Readonly<Record<string, unknown>> = {
  contentRedaction: true,
  builtInHeuristics: true,
  redactQueryParams: [],
  redactStorageKeys: [],
  valuePatterns: []
};

/** Local data defaults of earlier versions: unexported recordings were deleted after 10 minutes. */
const LEGACY_DEFAULT_LOCAL_DATA_SETTINGS: Readonly<ProfileLocalDataSettings> = {
  deleteAfterExport: true,
  unexportedRetentionMinutes: 10
};

/**
 * Capture policy fields a profile's recorder config takes from elsewhere: categories and redaction
 * come from the profile itself (`toLegacyOptionsRecord`).
 */
const OVERRIDDEN_BASE_POLICY_KEYS = new Set(["categories", "redaction"]);

/**
 * What a stored Default does, with every setting equal to its default left out:
 * - optional redaction settings at their default (as the profile form writes them back);
 * - sampling and freeze-on-error equal to the v1 defaults (as a v1 options save pinned them);
 * - a v1 capture policy that differs from the defaults only in fields the profile overrides
 *   (categories added later, such as `tabsContext`);
 * - local data settings equal to today's or the earlier defaults.
 */
function effectiveDefaultSettings(profile: RecordingProfile): Record<string, unknown> {
  const basePolicy = effectiveBasePolicy(profile.basePolicy);
  const localData = profile.localData;

  return {
    ...Object.fromEntries(
      Object.entries(profile).filter(([key]) => !IGNORED_DEFAULT_PROFILE_KEYS.has(key))
    ),
    redaction: withoutEntriesEqualTo(profile.redaction, DEFAULT_REDACTION_OPTIONS),
    sampling: withoutEntriesEqualTo(profile.sampling, DEFAULT_RECORDER_CONFIG.sampling),
    recorder: withoutEntriesEqualTo(profile.recorder, {
      freezeOnError: DEFAULT_RECORDER_CONFIG.freezeOnError
    }),
    basePolicy,
    localData: localData && isDefaultLocalData(localData) ? undefined : localData
  };
}

/** The capture policy fields that reach the recorder config; undefined when they are the defaults. */
function effectiveBasePolicy(
  policy: CapturePolicy | undefined
): Record<string, unknown> | undefined {
  if (!policy) {
    return undefined;
  }

  const effective = withoutKeys(policy, OVERRIDDEN_BASE_POLICY_KEYS);

  return stableStringify(effective) ===
    stableStringify(withoutKeys(DEFAULT_CAPTURE_POLICY, OVERRIDDEN_BASE_POLICY_KEYS))
    ? undefined
    : effective;
}

/** Today's local data defaults or the earlier ones. */
function isDefaultLocalData(settings: ProfileLocalDataSettings): boolean {
  return (
    isDefaultLocalDataSettings(settings) ||
    stableStringify(settings) === stableStringify(LEGACY_DEFAULT_LOCAL_DATA_SETTINGS)
  );
}

function withoutKeys(value: object, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

function withoutEntriesEqualTo(
  value: object,
  defaults: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) =>
        !Object.hasOwn(defaults, key) || stableStringify(entry) !== stableStringify(defaults[key])
    )
  );
}

function renameCustomisedDefault(profile: RecordingProfile): RecordingProfile {
  const legacyDescription = createDefaultProfile().description;

  return {
    ...profile,
    ...(profile.name === LEGACY_DEFAULT_PROFILE_NAME
      ? { name: CUSTOMISED_DEFAULT_PROFILE_NAME }
      : {}),
    ...(profile.description === legacyDescription
      ? { description: CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION }
      : {})
  };
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
