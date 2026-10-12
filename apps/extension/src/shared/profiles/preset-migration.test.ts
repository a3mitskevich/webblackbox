import { DEFAULT_CAPTURE_POLICY } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_ID,
  PROFILES_SCHEMA_VERSION,
  type ProfileRule,
  type RecordingProfilesStore
} from "./model.js";
import {
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

    expect(migrated.profiles).toEqual([{ ...customised, name: CUSTOMISED_DEFAULT_PROFILE_NAME }]);
    expect(migrated.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(migrated.rules[0]?.profileId).toBe(DEFAULT_PROFILE_ID);
  });

  it("keeps the name of a customised Default the user renamed", () => {
    const renamed = { ...createDefaultProfile(), name: "Shop", sampling: { scrollHz: 3 } };

    expect(migrateStoreToBuiltInPresets(legacyStore({ profiles: [renamed] })).profiles).toEqual([
      renamed
    ]);
  });

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
