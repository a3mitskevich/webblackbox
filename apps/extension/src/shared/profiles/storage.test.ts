import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  DEFAULT_REDACTION_PROFILE
} from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  PROFILES_SCHEMA_VERSION,
  type RecordingProfilesStore
} from "./model.js";
import {
  BUILT_IN_PROFILE_IDS,
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile,
  RECOMMENDED_PROFILE_IDS
} from "./presets.js";
import {
  applyDefaultProfileToGeneralForm,
  removeProfileFromStore,
  restoreRecommendedProfiles,
  migrateLegacyOptionsToProfiles,
  parseManagedProfilesPolicy,
  parseProfilesStore,
  resolveProfilesState,
  serializeProfilesStore,
  syncDefaultProfileWithLegacyOptions
} from "./storage.js";

const OPTIONS_PAGE_V1 = {
  ...DEFAULT_RECORDER_CONFIG,
  optionsVersion: 1,
  ringBufferMinutes: 7,
  freezeOnError: false,
  sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, mousemoveHz: 33, screenshotIdleMs: 500 },
  redaction: { ...DEFAULT_REDACTION_PROFILE, blockedSelectors: [".pii"] },
  performanceBudget: { lcpWarnMs: 2500 }
};

function storeWith(partial: Partial<RecordingProfilesStore>): RecordingProfilesStore {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: [createDefaultProfile()],
    rules: [],
    extendedCaptureHosts: [],
    ...partial
  };
}

describe("migrateLegacyOptionsToProfiles", () => {
  it("creates a Default profile with today's defaults when nothing is stored", () => {
    const store = migrateLegacyOptionsToProfiles(undefined);

    expect(store.schemaVersion).toBe(2);
    expect(store.defaultProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(store.profiles).toEqual([createDefaultProfile()]);
    expect(store.rules).toEqual([]);
  });

  it("carries every v1 knob into the Default profile", () => {
    const [profile] = migrateLegacyOptionsToProfiles(OPTIONS_PAGE_V1).profiles;

    expect(profile).toMatchObject({
      id: DEFAULT_PROFILE_ID,
      name: "Default",
      categories: DEFAULT_CAPTURE_POLICY.categories,
      recorder: { ringBufferMinutes: 7, freezeOnError: false },
      sampling: { mousemoveHz: 33, screenshotIdleMs: 500 },
      redaction: { blockedSelectors: [".pii"] },
      basePolicy: DEFAULT_CAPTURE_POLICY
    });
  });

  it("keeps raised v1 capture categories and the policy envelope", () => {
    const capturePolicy = {
      ...DEFAULT_CAPTURE_POLICY,
      captureContext: "synthetic" as const,
      categories: { ...DEFAULT_CAPTURE_POLICY.categories, console: "allow" as const }
    };
    const [profile] = migrateLegacyOptionsToProfiles({ capturePolicy }).profiles;

    expect(profile?.categories.console).toBe("allow");
    expect(profile?.basePolicy?.captureContext).toBe("synthetic");
  });

  it("applies the v1 screenshot migration before carrying sampling over", () => {
    const [profile] = migrateLegacyOptionsToProfiles({
      sampling: { screenshotIdleMs: 0 }
    }).profiles;

    expect(profile?.sampling.screenshotIdleMs).toBe(
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    );
  });

  it("drops invalid v1 values instead of failing", () => {
    const [profile] = migrateLegacyOptionsToProfiles({
      ringBufferMinutes: -3,
      sampling: { mousemoveHz: "fast", scrollHz: 9 },
      redaction: { blockedSelectors: "nope" },
      capturePolicy: { categories: { console: "everything" } },
      sitePolicies: [{ originPattern: 1 }]
    }).profiles;

    expect(profile?.recorder).toEqual({});
    expect(profile?.sampling).toEqual({ scrollHz: 9 });
    expect(profile?.redaction).toEqual(DEFAULT_REDACTION_PROFILE);
    expect(profile?.categories).toEqual(DEFAULT_CAPTURE_POLICY.categories);
    expect(profile?.basePolicy).toBeUndefined();
    expect(profile?.sitePolicies).toEqual([]);
  });
});

describe("parseProfilesStore", () => {
  it("returns null when nothing is stored or the envelope is corrupt", () => {
    expect(parseProfilesStore(undefined)).toBeNull();
    expect(parseProfilesStore("garbage")).toBeNull();
    expect(parseProfilesStore({ schemaVersion: 1, profiles: [] })).toBeNull();
  });

  it("drops invalid, reserved and duplicate rows but keeps the rest", () => {
    const custom = duplicateProfile(createDefaultProfile(), { id: "custom", name: "Custom" });
    const parsed = parseProfilesStore(
      storeWith({
        profiles: [
          createDefaultProfile(),
          custom,
          { ...custom },
          { ...custom, id: "builtin:qa" },
          { ...custom, id: "bad", categories: { console: "everything" } }
        ] as unknown as RecordingProfilesStore["profiles"],
        rules: [
          {
            id: "r1",
            profileId: "custom",
            priority: 1,
            enabled: true,
            match: { hosts: ["a.test"] }
          },
          { id: "r2", profileId: "custom", priority: 1, enabled: true, match: { titleRegex: "(" } }
        ] as RecordingProfilesStore["rules"]
      })
    );

    expect(parsed?.store.profiles.map((profile) => profile.id)).toEqual(["default", "custom"]);
    expect(parsed?.store.rules.map((rule) => rule.id)).toEqual(["r1"]);
    expect(parsed?.issues.map((issue) => issue.kind)).toEqual([
      "duplicate-id",
      "reserved-profile-id",
      "invalid-profile",
      "invalid-rule"
    ]);
  });

  it("re-adds a missing Default profile", () => {
    const parsed = parseProfilesStore(storeWith({ profiles: [] }));

    expect(parsed?.store.profiles.map((profile) => profile.id)).toEqual([DEFAULT_PROFILE_ID]);
  });
});

describe("resolveProfilesState", () => {
  it("derives a legacy Default from v1 options when no v2 store exists", () => {
    const state = resolveProfilesState({
      rawProfilesStore: undefined,
      rawLegacyOptions: OPTIONS_PAGE_V1
    });

    expect(state.legacy).toBe(true);
    expect(state.issues).toEqual([]);
    expect(state.catalog.map((profile) => profile.id)).toEqual([
      DEFAULT_PROFILE_ID,
      BUILT_IN_PROFILE_IDS.lite,
      BUILT_IN_PROFILE_IDS.full,
      BUILT_IN_PROFILE_IDS.qa,
      BUILT_IN_PROFILE_IDS.fullCapture
    ]);
    expect(state.catalog[0]?.recorder.ringBufferMinutes).toBe(7);
  });

  it("falls back to the v1 Default and reports a corrupt v2 store", () => {
    const state = resolveProfilesState({
      rawProfilesStore: { schemaVersion: 2, profiles: "broken" },
      rawLegacyOptions: OPTIONS_PAGE_V1
    });

    expect(state.legacy).toBe(true);
    expect(state.issues).toEqual([{ kind: "corrupt-store", message: expect.any(String) }]);
    expect(state.catalog[0]?.recorder.ringBufferMinutes).toBe(7);
  });

  it("uses the v2 store when present and resets an unknown default id", () => {
    const state = resolveProfilesState({
      rawProfilesStore: storeWith({ defaultProfileId: "ghost" }),
      rawLegacyOptions: OPTIONS_PAGE_V1
    });

    expect(state.legacy).toBe(false);
    expect(state.store.defaultProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(state.issues).toEqual([{ kind: "missing-default-profile", id: "ghost" }]);
    expect(state.catalog[0]?.recorder.ringBufferMinutes).toBeUndefined();
  });

  it("merges managed profiles and puts managed rules first", () => {
    const managed = parseManagedProfilesPolicy({
      profiles: [duplicateProfile(createDefaultProfile(), { id: "corp", name: "Corp" })],
      rules: [
        { id: "m1", profileId: "corp", priority: 5, enabled: true, match: {} },
        { id: "m2", profileId: BUILT_IN_PROFILE_IDS.qa, priority: 5, enabled: true, match: {} }
      ]
    });
    const state = resolveProfilesState({
      rawProfilesStore: storeWith({
        rules: [{ id: "u1", profileId: "default", priority: 1, enabled: true, match: {} }]
      }),
      rawLegacyOptions: undefined,
      managed
    });

    expect(state.catalog.map((profile) => profile.id)).toContain("managed:corp");
    expect(state.rules.map((rule) => [rule.id, rule.profileId])).toEqual([
      ["managed:m1", "managed:corp"],
      ["managed:m2", BUILT_IN_PROFILE_IDS.qa],
      ["u1", "default"]
    ]);
  });
});

describe("parseManagedProfilesPolicy", () => {
  it("fills blocks an admin left out and still rejects invalid values", () => {
    const managed = parseManagedProfilesPolicy({
      profiles: [
        { id: "corp-qa", name: "Corp QA", base: "full", categories: { console: "allow" } },
        { id: "bad", name: "Bad", categories: { console: "everything" } }
      ]
    });
    const profile = managed.profiles[0];

    expect(managed.profiles.map((entry) => entry.id)).toEqual(["managed:corp-qa"]);
    expect(profile?.categories.console).toBe("allow");
    expect(profile?.categories.inputs).toBe(createDefaultProfile().categories.inputs);
    expect(profile?.redaction).toEqual(createDefaultProfile().redaction);
    expect(profile?.export).toEqual(createDefaultProfile().export);
    expect(managed.issues).toEqual([
      expect.objectContaining({ kind: "invalid-profile", index: 1 })
    ]);
  });
});

describe("general settings form and the Default profile", () => {
  const edited = {
    ...createDefaultProfile(),
    redaction: {
      ...createDefaultProfile().redaction,
      blockedSelectors: [".from-editor"],
      redactCookieNames: ["editor_cookie"]
    },
    sampling: { scrollHz: 7 },
    recorder: { ringBufferMinutes: 4 },
    unmaskSelectors: [".order-id"]
  };

  it("copies only the fields the form edits onto the Default profile", () => {
    const synced = syncDefaultProfileWithLegacyOptions(storeWith({ profiles: [edited] }), {
      ...DEFAULT_RECORDER_CONFIG,
      optionsVersion: 1,
      redaction: { ...DEFAULT_RECORDER_CONFIG.redaction, blockedSelectors: [".from-form"] }
    });
    const profile = synced.profiles[0];

    expect(profile?.redaction.blockedSelectors).toEqual([".from-form"]);
    expect(profile?.redaction.redactCookieNames).toEqual(["editor_cookie"]);
    expect(profile?.unmaskSelectors).toEqual([".order-id"]);
    expect(profile?.categories).toEqual(edited.categories);
  });

  it("shows the Default profile's values in the form", () => {
    const form = applyDefaultProfileToGeneralForm(
      structuredClone(DEFAULT_RECORDER_CONFIG),
      storeWith({ profiles: [edited] })
    );

    expect(form.redaction.blockedSelectors).toEqual([".from-editor"]);
    expect(form.redaction.redactCookieNames).toEqual(
      DEFAULT_RECORDER_CONFIG.redaction.redactCookieNames
    );
    expect(form.sampling.scrollHz).toBe(7);
    expect(form.sampling.mousemoveHz).toBe(DEFAULT_RECORDER_CONFIG.sampling.mousemoveHz);
    expect(form.ringBufferMinutes).toBe(4);
  });
});

describe("serializeProfilesStore", () => {
  it("rejects invalid profiles instead of persisting them", () => {
    expect(() =>
      serializeProfilesStore(storeWith({ profiles: [{ ...createDefaultProfile(), name: "" }] }))
    ).toThrow(/Profiles are invalid/);
  });

  it("rejects a store the reader would drop as a whole", () => {
    const tooManyProfiles = Array.from({ length: MAX_PROFILES + 1 }, (_, index) => ({
      ...createDefaultProfile(),
      id: index === 0 ? DEFAULT_PROFILE_ID : `p${index}`
    }));

    expect(() =>
      serializeProfilesStore(storeWith({ extendedCaptureHosts: ["x".repeat(501)] }))
    ).toThrow(/Profiles are invalid: extendedCaptureHosts/);
    expect(() => serializeProfilesStore(storeWith({ profiles: tooManyProfiles }))).toThrow(
      /Profiles are invalid: profiles/
    );
  });

  it("round-trips a valid store", () => {
    const store = storeWith({ extendedCaptureHosts: ["*.stage.example.com"] });

    expect(parseProfilesStore(serializeProfilesStore(store))?.store).toEqual(store);
  });
});

describe("deleting and restoring recommended profiles", () => {
  const catalogIds = (store: RecordingProfilesStore): string[] =>
    resolveProfilesState({ rawProfilesStore: store, rawLegacyOptions: undefined }).catalog.map(
      (profile) => profile.id
    );

  it("hides deleted presets and the Default profile from the catalog", () => {
    const store = storeWith({
      profiles: [],
      removedRecommendedProfileIds: [DEFAULT_PROFILE_ID, BUILT_IN_PROFILE_IDS.qa]
    });
    const parsed = parseProfilesStore(store);

    expect(parsed?.store.profiles).toEqual([]);
    expect(catalogIds(store)).toEqual([
      BUILT_IN_PROFILE_IDS.lite,
      BUILT_IN_PROFILE_IDS.full,
      BUILT_IN_PROFILE_IDS.fullCapture
    ]);
  });

  it("leaves stores that never deleted a recommended profile byte-identical", () => {
    const store = storeWith({});
    const serialized = serializeProfilesStore(store);

    expect(serialized).toEqual(store);
    expect("removedRecommendedProfileIds" in serialized).toBe(false);
    expect(parseProfilesStore(serialized)?.store).toEqual(store);
  });

  it("drops unknown ids from the removed list", () => {
    const parsed = parseProfilesStore(
      storeWith({ removedRecommendedProfileIds: ["builtin:lite", "my-profile", "builtin:nope"] })
    );

    expect(parsed?.store.removedRecommendedProfileIds).toEqual([BUILT_IN_PROFILE_IDS.lite]);
  });

  it("removes any profile, keeps rules that point at it and moves the default", () => {
    const rule = {
      id: "r",
      profileId: DEFAULT_PROFILE_ID,
      priority: 0,
      enabled: true,
      match: { hosts: ["example.com"] }
    };
    const withoutDefault = removeProfileFromStore(storeWith({ rules: [rule] }), DEFAULT_PROFILE_ID);

    expect(withoutDefault.profiles).toEqual([]);
    expect(withoutDefault.removedRecommendedProfileIds).toEqual([DEFAULT_PROFILE_ID]);
    expect(withoutDefault.rules).toEqual([rule]);
    expect(withoutDefault.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.lite);

    const withoutLite = removeProfileFromStore(withoutDefault, BUILT_IN_PROFILE_IDS.lite);
    expect(withoutLite.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.full);

    const copy = duplicateProfile(createDefaultProfile(), { id: "mine" });
    const withCopy = storeWith({
      profiles: [createDefaultProfile(), copy],
      defaultProfileId: "mine"
    });
    expect(removeProfileFromStore(withCopy, "mine")).toEqual(storeWith({}));
  });

  it("never removes enterprise-managed profiles", () => {
    const store = storeWith({});

    expect(removeProfileFromStore(store, "managed:qa")).toBe(store);
  });

  it("can remove every profile; the catalog is then empty", () => {
    const empty = RECOMMENDED_PROFILE_IDS.reduce(removeProfileFromStore, storeWith({}));
    const state = resolveProfilesState({ rawProfilesStore: empty, rawLegacyOptions: undefined });

    expect(serializeProfilesStore(empty).removedRecommendedProfileIds).toEqual([
      ...RECOMMENDED_PROFILE_IDS
    ]);
    expect(state.catalog).toEqual([]);
    expect(state.legacy).toBe(false);
  });

  it("restores missing recommended profiles and keeps user profiles", () => {
    const copy = duplicateProfile(createDefaultProfile(), { id: "mine" });
    const empty = RECOMMENDED_PROFILE_IDS.reduce(
      removeProfileFromStore,
      storeWith({ profiles: [createDefaultProfile(), copy] })
    );
    const restored = restoreRecommendedProfiles(empty);

    expect(restored.removedRecommendedProfileIds).toBeUndefined();
    expect(restored.profiles.map((profile) => profile.id)).toEqual([DEFAULT_PROFILE_ID, "mine"]);
    expect(restored.profiles[0]).toEqual(createDefaultProfile());
    expect(catalogIds(restored)).toEqual([
      DEFAULT_PROFILE_ID,
      "mine",
      ...RECOMMENDED_PROFILE_IDS.filter((id) => findBuiltInProfile(id))
    ]);
  });

  it("points a default deleted with everything else back at Default on restore", () => {
    const mine = duplicateProfile(createDefaultProfile(), { id: "mine" });
    const empty = [...RECOMMENDED_PROFILE_IDS, "mine"].reduce(
      removeProfileFromStore,
      storeWith({ defaultProfileId: "mine", profiles: [createDefaultProfile(), mine] })
    );

    expect(empty.defaultProfileId).toBe("mine");
    expect(restoreRecommendedProfiles(empty).defaultProfileId).toBe(DEFAULT_PROFILE_ID);
  });
});
