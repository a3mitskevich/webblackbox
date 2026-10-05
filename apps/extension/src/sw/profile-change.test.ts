import { describe, expect, it } from "vitest";

import {
  applyEnterprisePolicyToRecorderConfig,
  normalizeEnterprisePolicy
} from "../shared/options-storage.js";
import { DEFAULT_PROFILE_ID, PROFILES_SCHEMA_VERSION } from "../shared/profiles/model.js";
import {
  BUILT_IN_PROFILE_IDS,
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile
} from "../shared/profiles/presets.js";
import {
  buildProfileRecorderConfig,
  selectRecordingProfile,
  type ProfileSelection
} from "../shared/profiles/resolve.js";
import { resolveProfilesState, type ProfilesState } from "../shared/profiles/storage.js";
import {
  buildProfileCancellation,
  detectProfileChange,
  toProfileCancelNotice,
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
