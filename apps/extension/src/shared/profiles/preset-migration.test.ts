import { DEFAULT_CAPTURE_POLICY, DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_ID,
  PROFILES_SCHEMA_VERSION,
  recordingProfileSchema,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "./model.js";
import {
  CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION,
  CUSTOMISED_DEFAULT_PROFILE_NAME,
  isPristineLegacyDefaultProfile,
  isRemovedBuiltInProfileId,
  migrateStoreToBuiltInPresets
} from "./preset-migration.js";
import { BUILT_IN_PROFILE_IDS, createDefaultProfile, duplicateProfile } from "./presets.js";
import { migrateLegacyOptionsToProfiles, parseManagedProfilesPolicy } from "./storage.js";

const MINE = duplicateProfile(createDefaultProfile(), { id: "mine", name: "Mine" });

function rule(id: string, profileId: string): ProfileRule {
  return { id, profileId, priority: 1, enabled: true, match: { hosts: [`${id}.example.com`] } };
}

/** A profile as `chrome.storage.local` gives it back: through the stored profile schema. */
function stored(profile: unknown): RecordingProfile {
  return recordingProfileSchema.parse(profile) as RecordingProfile;
}

/** The Default profile built from v1 options, as the settings migration builds it. */
function fromV1Options(options: Record<string, unknown>): RecordingProfile {
  const [profile] = migrateLegacyOptionsToProfiles(options).profiles;

  if (!profile) {
    throw new Error("v1 options built no Default profile");
  }

  return stored(profile);
}

const PRISTINE = createDefaultProfile();

/** Stored Defaults of earlier versions nobody customised, in the shapes those versions wrote. */
const UNTOUCHED_DEFAULTS: Record<string, RecordingProfile> = {
  // The profile editor writes every redaction setting back, optional ones included.
  "saved unchanged by the profile editor": stored({
    ...PRISTINE,
    redaction: {
      ...PRISTINE.redaction,
      contentRedaction: true,
      builtInHeuristics: true,
      redactQueryParams: [],
      redactStorageKeys: [],
      valuePatterns: []
    }
  }),
  // The options page of v1 saved the whole config: every sampling value and freeze-on-error.
  "migrated from a v1 options page save with the defaults": fromV1Options({
    ...DEFAULT_RECORDER_CONFIG,
    optionsVersion: 1,
    performanceBudget: { lcpWarnMs: 2_500, requestWarnMs: 1_000, errorRateWarnPct: 10 }
  }),
  // Capture policies written before the tabs context category existed lack it.
  "migrated from a v1 capture policy older than the tabs context": fromV1Options({
    optionsVersion: 1,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: Object.fromEntries(
        Object.entries(DEFAULT_CAPTURE_POLICY.categories).filter(([key]) => key !== "tabsContext")
      )
    }
  }),
  "with the earlier local data defaults written out": stored({
    ...PRISTINE,
    localData: { deleteAfterExport: true, unexportedRetentionMinutes: 10 }
  }),
  "with today's local data defaults written out": stored({
    ...PRISTINE,
    localData: { deleteAfterExport: true }
  })
};

/** Stored Defaults whose recordings differ from the untouched one. */
const CUSTOMISED_DEFAULTS: Record<string, RecordingProfile> = {
  "more masking": stored({
    ...PRISTINE,
    redaction: { ...PRISTINE.redaction, blockedSelectors: [".pii"] }
  }),
  "content masking off in the profile editor": stored({
    ...PRISTINE,
    redaction: { ...PRISTINE.redaction, contentRedaction: false }
  }),
  "query parameters masked": stored({
    ...PRISTINE,
    redaction: { ...PRISTINE.redaction, redactQueryParams: ["email"] }
  }),
  "other sampling": stored({ ...PRISTINE, sampling: { scrollHz: 7 } }),
  "v1 sampling changed": fromV1Options({
    ...DEFAULT_RECORDER_CONFIG,
    optionsVersion: 1,
    sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, mousemoveHz: 33 }
  }),
  "no freeze on error": stored({ ...PRISTINE, recorder: { freezeOnError: false } }),
  "synthetic capture context": fromV1Options({
    optionsVersion: 1,
    capturePolicy: { ...DEFAULT_CAPTURE_POLICY, captureContext: "synthetic" }
  }),
  "local copy kept after export": stored({ ...PRISTINE, localData: { deleteAfterExport: false } }),
  "unexported recordings kept for an hour": stored({
    ...PRISTINE,
    localData: { deleteAfterExport: true, unexportedRetentionMinutes: 60 }
  })
};

function legacyStore(partial: Partial<RecordingProfilesStore> = {}): RecordingProfilesStore {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: [createDefaultProfile(), MINE],
    rules: [],
    extendedCaptureHosts: [],
    ...partial
  };
}

describe("migrateStoreToBuiltInPresets", () => {
  it("drops an untouched Default and moves its references and removed presets to Maximum", () => {
    const migrated = migrateStoreToBuiltInPresets(
      legacyStore({
        rules: [
          rule("default", DEFAULT_PROFILE_ID),
          rule("qa", "builtin:qa"),
          rule("full", "builtin:full"),
          rule("capture", "builtin:full-capture"),
          rule("lite", BUILT_IN_PROFILE_IDS.lite),
          rule("mine", "mine")
        ]
      })
    );

    expect(migrated.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(migrated.profiles).toEqual([MINE]);
    expect(migrated.rules.map((entry) => entry.profileId)).toEqual([
      BUILT_IN_PROFILE_IDS.maximum,
      BUILT_IN_PROFILE_IDS.maximum,
      BUILT_IN_PROFILE_IDS.maximum,
      BUILT_IN_PROFILE_IDS.maximum,
      BUILT_IN_PROFILE_IDS.lite,
      "mine"
    ]);
  });

  it("keeps a customised Default as a user profile named Default (custom)", () => {
    const customised = {
      ...createDefaultProfile(),
      redaction: { ...createDefaultProfile().redaction, blockedSelectors: [".pii"] }
    };
    const migrated = migrateStoreToBuiltInPresets(
      legacyStore({ profiles: [customised], rules: [rule("default", DEFAULT_PROFILE_ID)] })
    );

    expect(migrated.profiles).toEqual([
      {
        ...customised,
        name: CUSTOMISED_DEFAULT_PROFILE_NAME,
        description: CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION
      }
    ]);
    expect(migrated.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(migrated.rules[0]?.profileId).toBe(DEFAULT_PROFILE_ID);
  });

  it("keeps the name of a customised Default the user renamed", () => {
    const renamed = { ...createDefaultProfile(), name: "Shop", sampling: { scrollHz: 3 } };

    expect(migrateStoreToBuiltInPresets(legacyStore({ profiles: [renamed] })).profiles).toEqual([
      { ...renamed, description: CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION }
    ]);
  });

  it("replaces the old Default description only", () => {
    const customised = { ...createDefaultProfile(), sampling: { scrollHz: 3 } };
    const described = { ...customised, description: "Checkout team settings" };
    const [kept] = migrateStoreToBuiltInPresets(legacyStore({ profiles: [customised] })).profiles;
    const [keptDescribed] = migrateStoreToBuiltInPresets(
      legacyStore({ profiles: [described] })
    ).profiles;

    expect(kept?.description).toBe(CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION);
    expect(keptDescribed?.description).toBe("Checkout team settings");
  });

  it.each(Object.entries(UNTOUCHED_DEFAULTS))(
    "drops a Default %s and moves its references to Maximum",
    (_label, profile) => {
      const migrated = migrateStoreToBuiltInPresets(
        legacyStore({ profiles: [profile, MINE], rules: [rule("default", DEFAULT_PROFILE_ID)] })
      );

      expect(migrated.profiles).toEqual([MINE]);
      expect(migrated.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
      expect(migrated.rules[0]?.profileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    }
  );

  it.each(Object.entries(CUSTOMISED_DEFAULTS))(
    "keeps a Default with %s as Default (custom)",
    (_label, profile) => {
      const migrated = migrateStoreToBuiltInPresets(
        legacyStore({ profiles: [profile], rules: [rule("default", DEFAULT_PROFILE_ID)] })
      );

      expect(migrated.profiles).toEqual([
        {
          ...profile,
          name: CUSTOMISED_DEFAULT_PROFILE_NAME,
          description: CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION
        }
      ]);
      expect(migrated.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
      expect(migrated.rules[0]?.profileId).toBe(DEFAULT_PROFILE_ID);
    }
  );

  it("keeps a user profile chosen as the default and user rules as they are", () => {
    const store = legacyStore({ defaultProfileId: "mine", rules: [rule("mine", "mine")] });
    const migrated = migrateStoreToBuiltInPresets(store);

    expect(migrated.defaultProfileId).toBe("mine");
    expect(migrated.rules).toEqual(store.rules);
  });

  it("maps a removed preset chosen as the default to Maximum", () => {
    expect(
      migrateStoreToBuiltInPresets(legacyStore({ defaultProfileId: "builtin:full" }))
        .defaultProfileId
    ).toBe(BUILT_IN_PROFILE_IDS.maximum);
  });

  it("lists deleted recommended profiles with the new ids only", () => {
    const withLite = migrateStoreToBuiltInPresets(
      legacyStore({
        removedRecommendedProfileIds: [DEFAULT_PROFILE_ID, "builtin:qa", BUILT_IN_PROFILE_IDS.lite]
      })
    );
    const withOldOnly = migrateStoreToBuiltInPresets(
      legacyStore({ removedRecommendedProfileIds: [DEFAULT_PROFILE_ID, "builtin:full"] })
    );

    expect(withLite.removedRecommendedProfileIds).toEqual([BUILT_IN_PROFILE_IDS.lite]);
    expect("removedRecommendedProfileIds" in withOldOnly).toBe(false);
  });

  it("does not mutate its input and is idempotent", () => {
    const store = legacyStore({ rules: [rule("qa", "builtin:qa")] });
    const snapshot = structuredClone(store);
    const once = migrateStoreToBuiltInPresets(store);

    expect(store).toEqual(snapshot);
    expect(migrateStoreToBuiltInPresets(once)).toEqual(once);
  });
});

describe("isPristineLegacyDefaultProfile", () => {
  it("ignores the name and description", () => {
    expect(isPristineLegacyDefaultProfile(createDefaultProfile())).toBe(true);
    expect(
      isPristineLegacyDefaultProfile({
        ...createDefaultProfile(),
        name: "Mine",
        description: "Edited text"
      })
    ).toBe(true);
  });

  it("counts a v1 capture policy equal to the defaults as unset", () => {
    const [migrated] = migrateLegacyOptionsToProfiles({
      optionsVersion: 1,
      capturePolicy: DEFAULT_CAPTURE_POLICY
    }).profiles;

    expect(migrated?.basePolicy).toEqual(DEFAULT_CAPTURE_POLICY);
    expect(isPristineLegacyDefaultProfile(migrated!)).toBe(true);
    expect(
      isPristineLegacyDefaultProfile({
        ...migrated!,
        basePolicy: { ...DEFAULT_CAPTURE_POLICY, captureContext: "synthetic" }
      })
    ).toBe(false);
  });

  it("flags any capture setting change as customised", () => {
    const base = createDefaultProfile();

    expect(isPristineLegacyDefaultProfile({ ...base, sampling: { scrollHz: 7 } })).toBe(false);
    expect(
      isPristineLegacyDefaultProfile({
        ...base,
        categories: { ...base.categories, console: "allow" }
      })
    ).toBe(false);
    expect(isPristineLegacyDefaultProfile({ ...base, recorder: { freezeOnError: false } })).toBe(
      false
    );
  });
});

describe("removed built-in profile ids", () => {
  it("names the presets of earlier versions only", () => {
    expect(isRemovedBuiltInProfileId("builtin:full")).toBe(true);
    expect(isRemovedBuiltInProfileId("builtin:qa")).toBe(true);
    expect(isRemovedBuiltInProfileId("builtin:full-capture")).toBe(true);
    expect(isRemovedBuiltInProfileId(BUILT_IN_PROFILE_IDS.maximum)).toBe(false);
    expect(isRemovedBuiltInProfileId(BUILT_IN_PROFILE_IDS.lite)).toBe(false);
    expect(isRemovedBuiltInProfileId(DEFAULT_PROFILE_ID)).toBe(false);
  });

  it("points managed rules at a removed preset to Maximum", () => {
    const managed = parseManagedProfilesPolicy({
      rules: [
        { id: "qa", profileId: "builtin:qa", priority: 1, enabled: true, match: {} },
        { id: "lite", profileId: BUILT_IN_PROFILE_IDS.lite, priority: 1, enabled: true, match: {} }
      ]
    });

    expect(managed.rules.map((entry) => [entry.id, entry.profileId])).toEqual([
      ["managed:qa", BUILT_IN_PROFILE_IDS.maximum],
      ["managed:lite", BUILT_IN_PROFILE_IDS.lite]
    ]);
  });
});
