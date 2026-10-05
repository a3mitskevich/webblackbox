import { describe, expect, it } from "vitest";

import { resolveModeBaseConfig } from "../shared/mode-profile.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  normalizeEnterprisePolicy
} from "../shared/options-storage.js";
import {
  DEFAULT_PROFILE_ID,
  PROFILES_SCHEMA_VERSION,
  PROFILES_STORAGE_KEY,
  type ProfileRule
} from "../shared/profiles/model.js";
import {
  BUILT_IN_PROFILE_IDS,
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile
} from "../shared/profiles/presets.js";
import {
  AUTO_PROFILE_ID,
  buildProfileRecorderConfig,
  selectRecordingProfile,
  type ProfileSelection
} from "../shared/profiles/resolve.js";
import {
  resolveProfilesState,
  syncDefaultProfileWithLegacyOptions,
  type ProfilesState
} from "../shared/profiles/storage.js";
import {
  buildProfileCancellation,
  detectProfileChange,
  isProfileSettingsChange,
  reselectStartedProfile,
  shouldDeferProfileCheck,
  toProfileCancelNotice,
  toSessionProfileRequest,
  type SessionProfileSnapshot
} from "./profile-change.js";

const PAGE = { url: "https://shop.example.com/cart" };
const NO_POLICY = normalizeEnterprisePolicy(undefined);

function state(partial: Partial<ProfilesState["store"]> = {}): ProfilesState {
  return resolveProfilesState({
    rawProfilesStore: {
      schemaVersion: PROFILES_SCHEMA_VERSION,
      defaultProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultProfile()],
      rules: [],
      extendedCaptureHosts: [],
      ...partial
    },
    rawLegacyOptions: undefined
  });
}

function select(profilesState: ProfilesState, requestedProfileId?: string): ProfileSelection {
  const selection = selectRecordingProfile({
    state: profilesState,
    page: PAGE,
    requestedProfileId
  });

  if (!selection) {
    throw new Error("no selection");
  }

  return selection;
}

function snapshot(
  selection: ProfileSelection,
  policy = NO_POLICY,
  reorderKeys = false
): SessionProfileSnapshot {
  const profileConfig = buildProfileRecorderConfig({ mode: "full", profile: selection.profile });
  const effectiveConfig = applyEnterprisePolicyToRecorderConfig(profileConfig, policy);

  return {
    selection,
    profileConfig: reorderKeys ? reverseKeys(profileConfig) : profileConfig,
    effectiveConfig: reorderKeys ? reverseKeys(effectiveConfig) : effectiveConfig
  };
}

function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(reverseKeys) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)])
    ) as T;
  }

  return value;
}

function qaCopy() {
  const qa = findBuiltInProfile(BUILT_IN_PROFILE_IDS.qa);

  if (!qa) {
    throw new Error("missing QA preset");
  }

  return duplicateProfile(qa, { id: "mine" });
}

const qaRule = {
  id: "shop-qa",
  name: "Shop",
  profileId: BUILT_IN_PROFILE_IDS.qa,
  priority: 10,
  enabled: true,
  match: { hosts: ["shop.example.com"] }
};

describe("detectProfileChange", () => {
  it("keeps recording when nothing changed, whatever the key order", () => {
    const started = snapshot(select(state({ rules: [qaRule] })));

    expect(
      detectProfileChange({
        started,
        next: snapshot(select(state({ rules: [qaRule] })), NO_POLICY, true),
        startedProfileExists: true
      })
    ).toBeNull();
  });

  it("ignores v1 option keys and the capture policy's redaction copy the session replaces", () => {
    const started = snapshot(select(state()));
    const { profileConfig } = started;
    // The legacy Default path spreads the stored v1 options record into the config.
    const legacyLike = {
      ...profileConfig,
      optionsVersion: 3,
      performanceBudget: { lcpWarnMs: 1 },
      capturePolicy: profileConfig.capturePolicy
        ? { ...profileConfig.capturePolicy, redaction: { ...profileConfig.redaction, x: 1 } }
        : undefined
    } as typeof profileConfig;

    expect(
      detectProfileChange({
        started,
        next: { ...started, profileConfig: legacyLike },
        startedProfileExists: true
      })
    ).toBeNull();
    expect(
      detectProfileChange({
        started,
        next: {
          ...started,
          profileConfig: {
            ...profileConfig,
            ringBufferMinutes: profileConfig.ringBufferMinutes + 1
          }
        },
        startedProfileExists: true
      })
    ).toBe("profile-edited");
  });

  it("reports an edit of settings the service worker reads from the profile itself", () => {
    const mine = qaCopy();
    const started = snapshot(select(state({ profiles: [createDefaultProfile(), mine] }), "mine"));
    const editedNetwork = {
      ...mine,
      network: { ...mine.network, excludeUrls: [...mine.network.excludeUrls, "*/health*"] }
    };
    const renamed = { ...mine, name: "Mine (renamed)", description: "Other words" };
    const next = (profile: typeof mine) =>
      snapshot(select(state({ profiles: [createDefaultProfile(), profile] }), "mine"));

    expect(
      detectProfileChange({ started, next: next(editedNetwork), startedProfileExists: true })
    ).toBe("profile-edited");
    expect(
      detectProfileChange({ started, next: next(renamed), startedProfileExists: true })
    ).toBeNull();
  });

  it("keeps recording when a General settings save pins the values Default already ran with", () => {
    const started = snapshot(select(state()));
    // Options saves the whole normalized config: every sampling and recorder value gets pinned.
    const synced = syncDefaultProfileWithLegacyOptions(
      state().store,
      structuredClone(resolveModeBaseConfig("full"))
    );
    const next = snapshot(select(state({ profiles: synced.profiles })));

    expect(next.selection.profile).not.toEqual(started.selection.profile);
    expect(detectProfileChange({ started, next, startedProfileExists: true })).toBeNull();
  });

  it("keeps recording when another rule picks the same profile", () => {
    const started = snapshot(select(state({ rules: [qaRule] })));
    const next = snapshot(
      select(state({ rules: [{ ...qaRule, id: "other", name: "Other", priority: 20 }] }))
    );

    expect(next.selection.rule?.id).toBe("other");
    expect(detectProfileChange({ started, next, startedProfileExists: true })).toBeNull();
  });

  it("reports a rule change when the rules pick another profile for the page", () => {
    const started = snapshot(select(state({ rules: [qaRule] })));
    const next = snapshot(select(state()));

    expect(detectProfileChange({ started, next, startedProfileExists: true })).toBe("rule-changed");
  });

  it("reports a missing profile when the recording's profile was deleted", () => {
    const mine = qaCopy();
    const started = snapshot(select(state({ profiles: [createDefaultProfile(), mine] }), "mine"));
    // The explicit id is gone: the selection falls back to the default profile.
    const next = snapshot(select(state(), "mine"));

    expect(detectProfileChange({ started, next, startedProfileExists: false })).toBe(
      "profile-missing"
    );
    expect(detectProfileChange({ started, next: null, startedProfileExists: false })).toBe(
      "profile-missing"
    );
  });

  it("reports an edit when the same profile now records something else", () => {
    const mine = qaCopy();
    const edited = { ...mine, categories: { ...mine.categories, console: "metadata" as const } };
    const started = snapshot(select(state({ profiles: [createDefaultProfile(), mine] }), "mine"));
    const next = snapshot(select(state({ profiles: [createDefaultProfile(), edited] }), "mine"));

    expect(detectProfileChange({ started, next, startedProfileExists: true })).toBe(
      "profile-edited"
    );
  });

  it("reports an enterprise policy change that caps the running profile", () => {
    const selection = select(state(), BUILT_IN_PROFILE_IDS.fullCapture);
    const started = snapshot(selection);
    const next = snapshot(
      selection,
      normalizeEnterprisePolicy({ dataCategoryCaps: { console: "metadata" } })
    );

    expect(detectProfileChange({ started, next, startedProfileExists: true })).toBe(
      "enterprise-policy"
    );
  });
});

describe("buildProfileCancellation / toProfileCancelNotice", () => {
  it("archives both profiles and gives the popup what it needs to explain the fix", () => {
    const started = snapshot(select(state({ rules: [qaRule] })));
    const next = snapshot(select(state()));
    const cancellation = buildProfileCancellation({
      reason: "rule-changed",
      trigger: "navigation",
      at: 1_700_000_000_000,
      started: started.selection,
      next: next.selection
    });

    expect(cancellation).toEqual({
      reason: "rule-changed",
      trigger: "navigation",
      at: 1_700_000_000_000,
      started: {
        id: BUILT_IN_PROFILE_IDS.qa,
        name: "QA",
        source: "rule",
        ruleId: "shop-qa",
        ruleName: "Shop",
        extended: true
      },
      next: { id: DEFAULT_PROFILE_ID, name: "Default", source: "default", extended: false }
    });
    expect(toProfileCancelNotice(cancellation)).toEqual({
      reason: "rule-changed",
      at: 1_700_000_000_000,
      startedName: "QA",
      nextName: "Default"
    });
  });

  it("leaves the next profile out when none exists", () => {
    const started = snapshot(select(state()));
    const cancellation = buildProfileCancellation({
      reason: "profile-missing",
      trigger: "page-loaded",
      at: 1,
      started: started.selection,
      next: null
    });

    expect(cancellation.next).toBeUndefined();
    expect(toProfileCancelNotice(cancellation)).toEqual({
      reason: "profile-missing",
      at: 1,
      startedName: "Default"
    });
  });
});

describe("shouldDeferProfileCheck", () => {
  const rule = (match: ProfileRule["match"], enabled = true): ProfileRule => ({
    id: "rule",
    profileId: "builtin:qa",
    priority: 1,
    enabled,
    match
  });
  const hostRule = rule({ hosts: ["shop.example.com"] });
  const pageSignalRules = [
    rule({ titleRegex: "Admin" }),
    rule({ selectorPresent: "#admin-app" }),
    rule({ metaTag: { name: "app", value: "admin" } })
  ];

  it("waits for the loaded page when a rule reads the title, meta tags or selectors", () => {
    for (const signalRule of pageSignalRules) {
      expect(
        shouldDeferProfileCheck({
          trigger: "navigation",
          tabLoading: true,
          rules: [hostRule, signalRule]
        })
      ).toBe(true);
      expect(
        shouldDeferProfileCheck({
          trigger: "settings-changed",
          tabLoading: true,
          rules: [signalRule]
        })
      ).toBe(true);
    }
  });

  it("checks at once when the rules read only the URL or the page has loaded", () => {
    expect(
      shouldDeferProfileCheck({ trigger: "navigation", tabLoading: true, rules: [hostRule] })
    ).toBe(false);
    expect(
      shouldDeferProfileCheck({
        trigger: "navigation",
        tabLoading: true,
        rules: [hostRule, rule({ titleRegex: "Admin" }, false)]
      })
    ).toBe(false);
    expect(
      shouldDeferProfileCheck({
        trigger: "navigation",
        tabLoading: false,
        rules: pageSignalRules
      })
    ).toBe(false);
    expect(
      shouldDeferProfileCheck({ trigger: "page-loaded", tabLoading: true, rules: pageSignalRules })
    ).toBe(false);
  });
});

describe("isProfileSettingsChange", () => {
  const keys = { legacyOptionsKey: "webblackbox.options" };

  it("re-checks running recordings when profiles, options or the managed policy change", () => {
    expect(isProfileSettingsChange({ [PROFILES_STORAGE_KEY]: {} }, "local", keys)).toBe(true);
    expect(isProfileSettingsChange({ "webblackbox.options": {} }, "local", keys)).toBe(true);
    expect(isProfileSettingsChange({ anything: {} }, "managed", keys)).toBe(true);
  });

  it("ignores unrelated storage writes", () => {
    expect(isProfileSettingsChange({ "webblackbox.runtime.sessions": {} }, "local", keys)).toBe(
      false
    );
    expect(isProfileSettingsChange({ [PROFILES_STORAGE_KEY]: {} }, "sync", keys)).toBe(false);
  });
});

describe("toSessionProfileRequest", () => {
  it("keeps an explicit choice and turns a deleted one into auto", () => {
    const profilesState = state();

    expect(
      toSessionProfileRequest(
        BUILT_IN_PROFILE_IDS.qa,
        select(profilesState, BUILT_IN_PROFILE_IDS.qa)
      )
    ).toBe(BUILT_IN_PROFILE_IDS.qa);
    // A stale popup choice: the profile was deleted, the rules picked the profile instead.
    expect(toSessionProfileRequest("user-deleted", select(profilesState, "user-deleted"))).toBe(
      AUTO_PROFILE_ID
    );
    expect(toSessionProfileRequest(AUTO_PROFILE_ID, select(profilesState, AUTO_PROFILE_ID))).toBe(
      AUTO_PROFILE_ID
    );
  });
});

describe("reselectStartedProfile", () => {
  it("finds the started profile as it is stored now, whatever the rules would pick", () => {
    const mine = qaCopy();
    const started = select(state({ profiles: [createDefaultProfile(), mine] }), "mine");
    const edited = { ...mine, categories: { ...mine.categories, console: "metadata" as const } };
    const again = reselectStartedProfile(
      started,
      state({ profiles: [createDefaultProfile(), edited] })
    );

    expect(again?.profile).toEqual(edited);
    expect(again?.source).toBe(started.source);
    expect(reselectStartedProfile(started, state())).toBeNull();
  });
});
