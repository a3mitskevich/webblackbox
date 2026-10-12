import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  DEFAULT_REDACTION_PROFILE,
  type CaptureMode,
  type RecorderConfig
} from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { applyFullModeVisualCapture, resolveModeBaseConfig } from "../mode-profile.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  normalizeEnterprisePolicy
} from "../options-storage.js";
import { resolveModeRecorderConfig } from "../recorder-config.js";
import { DEFAULT_PROFILE_ID, PROFILES_SCHEMA_VERSION, type RecordingProfile } from "./model.js";
import {
  BUILT_IN_PROFILE_IDS,
  BUILT_IN_PROFILES,
  createBaseProfile,
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile,
  RECOMMENDED_PROFILE_IDS
} from "./presets.js";
import {
  AUTO_PROFILE_ID,
  buildProfileRecorderConfig,
  isExtendedCaptureProfile,
  resolveSourceMapCapture,
  selectRecordingProfile,
  toArchivedProfileInfo
} from "./resolve.js";
import {
  migrateLegacyOptionsToProfiles,
  resolveProfilesState,
  type ProfilesState
} from "./storage.js";

const MODES: CaptureMode[] = ["lite", "full"];
const RECORDER_CONFIG_KEYS = Object.keys(DEFAULT_RECORDER_CONFIG) as Array<keyof RecorderConfig>;

function preset(id: string): RecordingProfile {
  const profile = findBuiltInProfile(id);

  if (!profile) {
    throw new Error(`missing preset ${id}`);
  }

  return profile;
}

/** A user profile with the settings of the Full preset of earlier versions. */
function fullLikeProfile(id = "full-like"): RecordingProfile {
  return createBaseProfile({ id, name: "Full-like", base: "full" });
}

/** A user profile with the settings of the QA preset of earlier versions. */
function qaLikeProfile(id = "qa-like"): RecordingProfile {
  const base = createBaseProfile({ id, name: "QA", base: "full" });

  return {
    ...base,
    categories: {
      ...base.categories,
      actions: "allow",
      console: "allow",
      network: "body-allowlist",
      screenshots: "allow",
      cdp: "safe-subset",
      tabsContext: "allow"
    },
    network: {
      bodyMimeAllowlist: ["application/json", "text/plain"],
      bodyMaxBytes: 256 * 1024,
      includeUrls: [],
      excludeUrls: []
    },
    sourceMaps: { mode: "embed" }
  };
}

/** RecorderConfig keys only, with the session-start redaction override the SW applies. */
function pickRecorderConfig(config: RecorderConfig): Partial<RecorderConfig> {
  const picked = Object.fromEntries(RECORDER_CONFIG_KEYS.map((key) => [key, config[key]]));

  return {
    ...picked,
    capturePolicy: config.capturePolicy
      ? { ...config.capturePolicy, redaction: config.redaction }
      : undefined
  };
}

function legacyConfig(mode: CaptureMode, stored: unknown, visual?: "screenshots" | "none") {
  return applyFullModeVisualCapture(
    resolveModeRecorderConfig(mode, resolveModeBaseConfig(mode), stored),
    mode,
    visual
  );
}

function v2State(partial: Partial<ProfilesState["store"]> = {}): ProfilesState {
  return resolveProfilesState({
    rawProfilesStore: {
      schemaVersion: PROFILES_SCHEMA_VERSION,
      defaultProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultProfile()],
      rules: [],
      extendedCaptureHosts: [],
      ...partial
    }
  });
}

const LEGACY_FIXTURES: Record<string, unknown> = {
  "nothing stored": undefined,
  "options page save": {
    ...DEFAULT_RECORDER_CONFIG,
    optionsVersion: 1,
    ringBufferMinutes: 5,
    sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, mousemoveHz: 30, bodyCaptureMaxBytes: 65536 },
    redaction: { ...DEFAULT_REDACTION_PROFILE, redactBodyPatterns: ["pin"] },
    performanceBudget: { lcpWarnMs: 1 }
  },
  "harness capture policy": {
    optionsVersion: 1,
    sampling: { mousemoveHz: 20, screenshotIdleMs: 600, bodyCaptureMaxBytes: 65536 },
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      mode: "debug",
      captureContext: "synthetic",
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        console: "allow",
        network: "body-allowlist",
        storage: "allow",
        cdp: "full"
      }
    },
    sitePolicies: [
      {
        originPattern: "https://*.example.test",
        mode: "full",
        enabled: true,
        allowBodyCapture: true,
        bodyMimeAllowlist: ["application/json"],
        pathAllowlist: [],
        pathDenylist: []
      }
    ]
  }
};

describe("buildProfileRecorderConfig — Default profile keeps today's behaviour", () => {
  for (const [label, stored] of Object.entries(LEGACY_FIXTURES)) {
    for (const mode of MODES) {
      for (const visual of [undefined, "screenshots", "none"] as const) {
        it(`${label} / ${mode} / visual ${visual ?? "unset"}`, () => {
          const [profile] = migrateLegacyOptionsToProfiles(stored).profiles;

          expect(profile).toBeDefined();
          expect(
            pickRecorderConfig(
              buildProfileRecorderConfig({ mode, profile: profile!, visualCapture: visual })
            )
          ).toEqual(pickRecorderConfig(legacyConfig(mode, stored, visual)));
        });
      }
    }
  }
});

describe("buildProfileRecorderConfig — presets", () => {
  it("Light (and a plain Full copy) equal today's defaults for their transport", () => {
    for (const mode of MODES) {
      for (const profile of [preset(BUILT_IN_PROFILE_IDS.lite), fullLikeProfile()]) {
        expect(pickRecorderConfig(buildProfileRecorderConfig({ mode, profile }))).toEqual(
          pickRecorderConfig(legacyConfig(mode, undefined))
        );
      }
    }

    expect(preset(BUILT_IN_PROFILE_IDS.lite)).toMatchObject({ name: "Light", base: "lite" });
  });

  it("a QA-like profile records console text, 256 KiB bodies, screenshots, the page DOM and other tabs' paths", () => {
    const config = buildProfileRecorderConfig({
      mode: "full",
      profile: qaLikeProfile(),
      visualCapture: "screenshots"
    });

    expect(config.capturePolicy?.categories).toEqual({
      ...DEFAULT_CAPTURE_POLICY.categories,
      actions: "allow",
      // Full mode records the page DOM at the default level, masked by the profile's rules.
      dom: "allow",
      console: "allow",
      network: "body-allowlist",
      screenshots: "allow",
      cdp: "safe-subset",
      tabsContext: "allow"
    });
    expect(config.sampling.bodyCaptureMaxBytes).toBe(256 * 1024);
    expect(config.redaction).toEqual(DEFAULT_REDACTION_PROFILE);
  });

  it("Maximum raises every category except heap profiles, records the raw DOM and samples the pointer at 60 Hz", () => {
    const config = buildProfileRecorderConfig({
      mode: "full",
      profile: preset(BUILT_IN_PROFILE_IDS.maximum),
      // The popup choice no longer matters: Maximum pins screenshots and the tab video.
      visualCapture: "none"
    });

    expect(config.capturePolicy?.categories).toEqual({
      actions: "allow",
      inputs: "allow",
      dom: "allow",
      screenshots: "allow",
      screenRecordings: "allow",
      console: "allow",
      network: "body-allowlist",
      storage: "allow",
      indexedDb: "allow",
      cookies: "allow",
      cdp: "full",
      heapProfiles: "off",
      tabsContext: "allow"
    });
    expect(config.sampling.mousemoveHz).toBe(60);
    expect(config.sampling.bodyCaptureMaxBytes).toBe(1024 * 1024);
    // Content is recorded raw: masking off, no blocked selectors (both views of the rules).
    expect(config.redaction.contentRedaction).toBe(false);
    expect(config.capturePolicy?.redaction.contentRedaction).toBe(false);
    expect(config.capturePolicy?.redaction.blockedSelectors).toEqual([]);
    expect(preset(BUILT_IN_PROFILE_IDS.maximum)).toMatchObject({
      name: "Maximum",
      base: "full",
      visual: "both",
      sourceMaps: { mode: "embed" }
    });
    // Unexported recordings are kept until they are exported or deleted.
    expect(preset(BUILT_IN_PROFILE_IDS.maximum).localData).toBeUndefined();
  });

  it("keeps SVG bodies in Maximum, like the Full engine's default allowlist", () => {
    expect(preset(BUILT_IN_PROFILE_IDS.maximum).network.bodyMimeAllowlist).toContain(
      "image/svg+xml"
    );
  });

  it("records the raw DOM in Maximum, and in other profiles only when a copy opts in", () => {
    expect(qaLikeProfile().categories.dom).toBe(fullLikeProfile().categories.dom);
    expect(preset(BUILT_IN_PROFILE_IDS.maximum).categories.dom).toBe("allow");

    const copy = duplicateProfile(qaLikeProfile(), { id: "raw-dom" });
    const config = buildProfileRecorderConfig({
      mode: "full",
      profile: { ...copy, categories: { ...copy.categories, dom: "allow" } },
      visualCapture: "screenshots"
    });

    expect(config.capturePolicy?.categories.dom).toBe("allow");
  });

  it("keeps content masking on in every preset but Maximum", () => {
    for (const profile of BUILT_IN_PROFILES) {
      expect(profile.redaction.contentRedaction !== false, profile.id).toBe(
        profile.id !== BUILT_IN_PROFILE_IDS.maximum
      );
    }

    expect(createDefaultProfile().redaction.contentRedaction).toBeUndefined();
  });

  it("treats a profile that turns masking off as extended and runs it as chosen on any host", () => {
    const fullCopy = duplicateProfile(fullLikeProfile(), { id: "raw" });
    const raw = { ...fullCopy, redaction: { ...fullCopy.redaction, contentRedaction: false } };

    expect(isExtendedCaptureProfile(fullCopy)).toBe(false);
    expect(isExtendedCaptureProfile(raw)).toBe(true);
    expect(
      isExtendedCaptureProfile({
        ...fullCopy,
        redaction: { ...fullCopy.redaction, builtInHeuristics: false }
      })
    ).toBe(true);

    const state = v2State({ profiles: [createDefaultProfile(), raw] });
    const selection = selectRecordingProfile({
      state,
      page: { url: "https://elsewhere.test/" },
      requestedProfileId: "raw"
    });

    expect(selection?.profile).toEqual(raw);
    expect(selection?.extended).toBe(true);
  });

  it("hands the profile's pointer streams to the recorder config", () => {
    const maximum = buildProfileRecorderConfig({
      mode: "lite",
      profile: preset(BUILT_IN_PROFILE_IDS.maximum)
    });
    const defaults = buildProfileRecorderConfig({ mode: "full", profile: createDefaultProfile() });

    expect(maximum.pointer).toEqual({ hover: true, drag: true, wheel: true });
    expect(defaults.pointer).toEqual({ hover: false, drag: false, wheel: false });
  });

  it("treats other tabs' paths and titles as extended capture and records them on any host", () => {
    const fullCopy = duplicateProfile(fullLikeProfile(), { id: "tabs" });
    const tabs = {
      ...fullCopy,
      categories: { ...fullCopy.categories, tabsContext: "allow" as const }
    };

    expect(fullCopy.categories.tabsContext).toBe("metadata");
    expect(isExtendedCaptureProfile(tabs)).toBe(true);
    expect(
      isExtendedCaptureProfile({
        ...fullCopy,
        categories: { ...fullCopy.categories, tabsContext: "off" }
      })
    ).toBe(false);

    const selection = selectRecordingProfile({
      state: v2State({ profiles: [createDefaultProfile(), tabs] }),
      page: { url: "https://elsewhere.test/" },
      requestedProfileId: "tabs"
    });

    expect(selection).toMatchObject({ source: "explicit", extended: true });
    expect(selection?.profile.categories.tabsContext).toBe("allow");
  });

  it("caps other tabs' details with the enterprise tabsContext cap", () => {
    const config = applyEnterprisePolicyToRecorderConfig(
      buildProfileRecorderConfig({ mode: "full", profile: qaLikeProfile() }),
      normalizeEnterprisePolicy({ dataCategoryCaps: { tabsContext: "off" } })
    );

    expect(config.capturePolicy?.categories.tabsContext).toBe("off");
  });

  it("keeps the lite transport boundary: no page-side bodies even for a QA-like profile", () => {
    const config = buildProfileRecorderConfig({
      mode: "lite",
      profile: qaLikeProfile()
    });

    expect(config.sampling.bodyCaptureMaxBytes).toBe(0);
  });

  it("lets a profile pin visual capture over the popup choice", () => {
    const profile = {
      ...duplicateProfile(fullLikeProfile(), { id: "v" }),
      visual: "none" as const
    };
    const config = buildProfileRecorderConfig({ mode: "full", profile, visualCapture: "both" });

    expect(config.capturePolicy?.categories.screenshots).toBe("off");
    expect(config.capturePolicy?.categories.screenRecordings).toBe("off");
  });

  it("passes unmask selectors into the redaction profile", () => {
    const profile = {
      ...duplicateProfile(fullLikeProfile(), { id: "u" }),
      unmaskSelectors: [".order-id"]
    };
    const config = buildProfileRecorderConfig({ mode: "full", profile });

    expect(config.redaction.unmaskSelectors).toEqual([".order-id"]);
    expect(config.capturePolicy?.redaction.unmaskSelectors).toEqual([".order-id"]);
  });

  it("never unmasks from a list hidden inside the redaction profile", () => {
    const profile = {
      ...duplicateProfile(fullLikeProfile(), { id: "h" }),
      redaction: { ...DEFAULT_REDACTION_PROFILE, unmaskSelectors: ["input"] }
    };
    const config = buildProfileRecorderConfig({ mode: "full", profile });

    expect(isExtendedCaptureProfile(profile)).toBe(false);
    expect(config.redaction.unmaskSelectors).toBeUndefined();
    expect(config.capturePolicy?.redaction.unmaskSelectors).toBeUndefined();

    const stored = v2State({ profiles: [createDefaultProfile(), profile] });
    expect(stored.catalog.find((entry) => entry.id === "h")?.redaction.unmaskSelectors).toBe(
      undefined
    );
  });

  it("stays under enterprise data category caps", () => {
    const config = applyEnterprisePolicyToRecorderConfig(
      buildProfileRecorderConfig({
        mode: "full",
        profile: preset(BUILT_IN_PROFILE_IDS.maximum)
      }),
      normalizeEnterprisePolicy({ dataCategoryCaps: { console: "metadata", network: "metadata" } })
    );

    expect(config.capturePolicy?.categories.console).toBe("metadata");
    expect(config.capturePolicy?.categories.network).toBe("metadata");
    expect(config.capturePolicy?.categories.inputs).toBe("allow");
  });
});

describe("isExtendedCaptureProfile", () => {
  it("flags Maximum and a QA-like profile, not Light or a plain Full copy", () => {
    expect(
      Object.fromEntries(
        BUILT_IN_PROFILES.map((profile) => [profile.id, isExtendedCaptureProfile(profile)])
      )
    ).toEqual({
      [BUILT_IN_PROFILE_IDS.maximum]: true,
      [BUILT_IN_PROFILE_IDS.lite]: false
    });
    expect(isExtendedCaptureProfile(qaLikeProfile())).toBe(true);
    expect(isExtendedCaptureProfile(fullLikeProfile())).toBe(false);
    expect(isExtendedCaptureProfile(createDefaultProfile())).toBe(false);
  });

  it("flags edited copies and unmask lists", () => {
    const copy = duplicateProfile(fullLikeProfile(), { id: "c" });

    expect(
      isExtendedCaptureProfile({
        ...copy,
        categories: { ...copy.categories, console: "sanitized" }
      })
    ).toBe(true);
    expect(isExtendedCaptureProfile({ ...copy, unmaskSelectors: [".x"] })).toBe(true);
  });

  it("does not flag a profile for recording the page DOM, which Full mode records by default", () => {
    const copy = duplicateProfile(fullLikeProfile(), { id: "dom" });

    expect(
      isExtendedCaptureProfile({ ...copy, categories: { ...copy.categories, dom: "allow" } })
    ).toBe(false);
  });
});

describe("selectRecordingProfile", () => {
  const stage = "https://qa.stage.example.com/orders";
  const foreign = "https://mail.example.org/inbox";
  const qaLike = qaLikeProfile();
  const qaRule = {
    id: "stage-qa",
    name: "Stage",
    profileId: qaLike.id,
    priority: 10,
    enabled: true,
    match: { hosts: ["*.stage.example.com"] }
  };

  it("falls back to the store default without rules", () => {
    const selection = selectRecordingProfile({ state: v2State(), page: { url: foreign } });

    expect(selection).toMatchObject({ source: "default", extended: false });
    expect(selection?.profile.id).toBe(DEFAULT_PROFILE_ID);
  });

  it("selects the rule's profile and records the rule", () => {
    const selection = selectRecordingProfile({
      state: v2State({ profiles: [createDefaultProfile(), qaLike], rules: [qaRule] }),
      page: { url: stage },
      requestedProfileId: AUTO_PROFILE_ID
    });

    expect(selection?.profile.id).toBe(qaLike.id);
    expect(selection).toMatchObject({
      source: "rule",
      rule: { id: "stage-qa", name: "Stage" },
      extended: true
    });
    expect(selection && toArchivedProfileInfo(selection)).toEqual({
      id: qaLike.id,
      name: "QA",
      source: "rule",
      ruleId: "stage-qa",
      ruleName: "Stage",
      extended: true
    });
  });

  it("lets an explicit choice win over rules", () => {
    const selection = selectRecordingProfile({
      state: v2State({ rules: [qaRule] }),
      page: { url: stage },
      requestedProfileId: BUILT_IN_PROFILE_IDS.lite
    });

    expect(selection).toMatchObject({ source: "explicit", extended: false });
    expect(selection?.profile.id).toBe(BUILT_IN_PROFILE_IDS.lite);
  });

  it("runs an explicitly chosen extended profile on a host without rules, unchanged", () => {
    const selection = selectRecordingProfile({
      state: v2State({ rules: [qaRule] }),
      page: { url: foreign },
      requestedProfileId: BUILT_IN_PROFILE_IDS.maximum
    });

    expect(selection?.profile).toEqual(preset(BUILT_IN_PROFILE_IDS.maximum));
    expect(selection).toMatchObject({ source: "explicit", extended: true });
    expect(selection && toArchivedProfileInfo(selection)).toEqual({
      id: BUILT_IN_PROFILE_IDS.maximum,
      name: "Maximum",
      source: "explicit",
      extended: true
    });
  });

  it("no longer gates extended profiles by host lists", () => {
    const pick = (state: ProfilesState, url: string) =>
      selectRecordingProfile({ state, page: { url }, requestedProfileId: qaLike.id })?.profile.id;
    const profiles = [createDefaultProfile(), qaLike];

    for (const state of [
      v2State({ profiles }),
      v2State({ profiles, rules: [{ ...qaRule, enabled: false }] }),
      v2State({ profiles, rules: [{ ...qaRule, profileId: BUILT_IN_PROFILE_IDS.maximum }] }),
      v2State({ profiles, extendedCaptureHosts: ["localhost:*"] })
    ]) {
      expect(pick(state, foreign)).toBe(qaLike.id);
      expect(pick(state, "http://localhost:5173/")).toBe(qaLike.id);
    }
  });

  it("runs a Default migrated from raised v1 options as extended, and presets as chosen", () => {
    const state = v2State({
      profiles: migrateLegacyOptionsToProfiles(LEGACY_FIXTURES["harness capture policy"]).profiles
    });
    const migratedDefault = selectRecordingProfile({ state, page: { url: foreign } });
    const maximum = selectRecordingProfile({
      state,
      page: { url: foreign },
      requestedProfileId: BUILT_IN_PROFILE_IDS.maximum
    });

    expect(migratedDefault).toMatchObject({ source: "default", extended: true });
    expect(migratedDefault?.profile.categories.console).toBe("allow");
    expect(maximum?.profile.id).toBe(BUILT_IN_PROFILE_IDS.maximum);
  });

  it("treats an edited Default above Full as extended", () => {
    const raised = {
      ...createDefaultProfile(),
      categories: { ...createDefaultProfile().categories, console: "allow" as const }
    };
    const selection = selectRecordingProfile({
      state: v2State({ profiles: [raised] }),
      page: { url: foreign }
    });

    expect(selection).toMatchObject({ extended: true, source: "default" });
    expect(selection?.profile).toEqual(raised);
  });

  it("lets a lower-priority rule win over one pointing to a missing profile", () => {
    const selection = selectRecordingProfile({
      state: v2State({
        rules: [
          { ...qaRule, id: "ghost", profileId: "ghost", priority: 10 },
          { ...qaRule, id: "lite", profileId: BUILT_IN_PROFILE_IDS.lite, priority: 1 }
        ]
      }),
      page: { url: stage }
    });

    expect(selection?.profile.id).toBe(BUILT_IN_PROFILE_IDS.lite);
    expect(selection?.rule?.id).toBe("lite");
  });

  it("ignores unknown explicit ids and rules to missing profiles", () => {
    const selection = selectRecordingProfile({
      state: v2State({ rules: [{ ...qaRule, profileId: "ghost" }] }),
      page: { url: stage },
      requestedProfileId: "nope"
    });

    expect(selection).toMatchObject({ source: "default" });
    expect(selection?.profile.id).toBe(DEFAULT_PROFILE_ID);
  });

  it("falls back to Maximum when the default was deleted", () => {
    const withoutDefault = v2State({ profiles: [] });

    expect(
      selectRecordingProfile({ state: withoutDefault, page: { url: foreign } })?.profile.id
    ).toBe(BUILT_IN_PROFILE_IDS.maximum);
  });

  it("falls back to the first profile left when the default and Maximum were deleted, and to none at all", () => {
    const withoutDefault = v2State({
      profiles: [],
      removedRecommendedProfileIds: [BUILT_IN_PROFILE_IDS.maximum]
    });

    expect(
      selectRecordingProfile({ state: withoutDefault, page: { url: foreign } })?.profile.id
    ).toBe(BUILT_IN_PROFILE_IDS.lite);

    const empty = v2State({
      profiles: [],
      removedRecommendedProfileIds: [...RECOMMENDED_PROFILE_IDS]
    });

    expect(selectRecordingProfile({ state: empty, page: { url: foreign } })).toBeNull();
    expect(
      selectRecordingProfile({
        state: empty,
        page: { url: foreign },
        requestedProfileId: BUILT_IN_PROFILE_IDS.maximum
      })
    ).toBeNull();
  });
});

describe("resolveSourceMapCapture", () => {
  it("records references in Full mode and nothing in Lite unless the profile says otherwise", () => {
    const profile = createDefaultProfile();

    expect(resolveSourceMapCapture(profile, "full")).toEqual({
      mode: "metadata",
      maxMapBytes: 8 * 1024 * 1024
    });
    expect(resolveSourceMapCapture(profile, "lite").mode).toBe("off");
    expect(resolveSourceMapCapture({ sourceMaps: { mode: "off" } }, "full").mode).toBe("off");
    expect(
      resolveSourceMapCapture({ sourceMaps: { mode: "metadata", maxMapBytes: 1024 } }, "lite")
    ).toEqual({ mode: "metadata", maxMapBytes: 1024 });
  });

  it("embeds maps for the Maximum preset only", () => {
    expect(
      BUILT_IN_PROFILES.filter(
        (profile) => resolveSourceMapCapture(profile, "full").mode === "embed"
      ).map((profile) => profile.id)
    ).toEqual([BUILT_IN_PROFILE_IDS.maximum]);
  });
});
