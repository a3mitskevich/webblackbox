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
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile
} from "./presets.js";
import {
  AUTO_PROFILE_ID,
  buildProfileRecorderConfig,
  isExtendedCaptureProfile,
  resolveProfileExportRequirements,
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
    },
    rawLegacyOptions: undefined
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
  it("Lite and Full presets equal today's defaults for their transport", () => {
    for (const mode of MODES) {
      for (const id of [BUILT_IN_PROFILE_IDS.lite, BUILT_IN_PROFILE_IDS.full]) {
        expect(
          pickRecorderConfig(buildProfileRecorderConfig({ mode, profile: preset(id) }))
        ).toEqual(pickRecorderConfig(legacyConfig(mode, undefined)));
      }
    }
  });

  it("QA records console text and 256 KiB JSON bodies with raw DOM and screenshots", () => {
    const config = buildProfileRecorderConfig({
      mode: "full",
      profile: preset(BUILT_IN_PROFILE_IDS.qa),
      visualCapture: "screenshots"
    });

    expect(config.capturePolicy?.categories).toEqual({
      ...DEFAULT_CAPTURE_POLICY.categories,
      actions: "allow",
      console: "allow",
      network: "body-allowlist",
      dom: "allow",
      screenshots: "allow",
      cdp: "safe-subset"
    });
    expect(config.sampling.bodyCaptureMaxBytes).toBe(256 * 1024);
    expect(config.redaction).toEqual(DEFAULT_REDACTION_PROFILE);
  });

  it("Full capture raises every category except heap profiles and samples the pointer at 60 Hz", () => {
    const config = buildProfileRecorderConfig({
      mode: "full",
      profile: preset(BUILT_IN_PROFILE_IDS.fullCapture),
      visualCapture: "both"
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
      indexedDb: "names-only",
      cookies: "names-only",
      cdp: "full",
      heapProfiles: "off"
    });
    expect(config.sampling.mousemoveHz).toBe(60);
    expect(config.sampling.bodyCaptureMaxBytes).toBe(1024 * 1024);
    expect(config.capturePolicy?.redaction.blockedSelectors).toContain("input[type='password']");
  });

  it("keeps the lite transport boundary: no page-side bodies even for QA", () => {
    const config = buildProfileRecorderConfig({
      mode: "lite",
      profile: preset(BUILT_IN_PROFILE_IDS.qa)
    });

    expect(config.sampling.bodyCaptureMaxBytes).toBe(0);
  });

  it("lets a profile pin visual capture over the popup choice", () => {
    const profile = {
      ...duplicateProfile(preset(BUILT_IN_PROFILE_IDS.full), { id: "v" }),
      visual: "none" as const
    };
    const config = buildProfileRecorderConfig({ mode: "full", profile, visualCapture: "both" });

    expect(config.capturePolicy?.categories.screenshots).toBe("off");
    expect(config.capturePolicy?.categories.screenRecordings).toBe("off");
  });

  it("passes unmask selectors into the redaction profile", () => {
    const profile = {
      ...duplicateProfile(preset(BUILT_IN_PROFILE_IDS.full), { id: "u" }),
      unmaskSelectors: [".order-id"]
    };
    const config = buildProfileRecorderConfig({ mode: "full", profile });

    expect(config.redaction.unmaskSelectors).toEqual([".order-id"]);
    expect(config.capturePolicy?.redaction.unmaskSelectors).toEqual([".order-id"]);
  });

  it("never unmasks from a list hidden inside the redaction profile", () => {
    const profile = {
      ...duplicateProfile(preset(BUILT_IN_PROFILE_IDS.full), { id: "h" }),
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
        profile: preset(BUILT_IN_PROFILE_IDS.fullCapture)
      }),
      normalizeEnterprisePolicy({ dataCategoryCaps: { console: "metadata", network: "metadata" } })
    );

    expect(config.capturePolicy?.categories.console).toBe("metadata");
    expect(config.capturePolicy?.categories.network).toBe("metadata");
    expect(config.capturePolicy?.categories.inputs).toBe("allow");
  });
});

describe("isExtendedCaptureProfile", () => {
  it("flags QA and Full capture only", () => {
    expect(
      Object.fromEntries(
        BUILT_IN_PROFILES.map((profile) => [profile.id, isExtendedCaptureProfile(profile)])
      )
    ).toEqual({
      [BUILT_IN_PROFILE_IDS.lite]: false,
      [BUILT_IN_PROFILE_IDS.full]: false,
      [BUILT_IN_PROFILE_IDS.qa]: true,
      [BUILT_IN_PROFILE_IDS.fullCapture]: true
    });
    expect(isExtendedCaptureProfile(createDefaultProfile())).toBe(false);
  });

  it("flags edited copies and unmask lists", () => {
    const copy = duplicateProfile(preset(BUILT_IN_PROFILE_IDS.full), { id: "c" });

    expect(
      isExtendedCaptureProfile({
        ...copy,
        categories: { ...copy.categories, console: "sanitized" }
      })
    ).toBe(true);
    expect(isExtendedCaptureProfile({ ...copy, unmaskSelectors: [".x"] })).toBe(true);
  });
});

describe("selectRecordingProfile", () => {
  const stage = "https://qa.stage.example.com/orders";
  const foreign = "https://mail.example.org/inbox";
  const qaRule = {
    id: "stage-qa",
    name: "Stage",
    profileId: BUILT_IN_PROFILE_IDS.qa,
    priority: 10,
    enabled: true,
    match: { hosts: ["*.stage.example.com"] }
  };

  it("falls back to the store default without rules", () => {
    const selection = selectRecordingProfile({ state: v2State(), page: { url: foreign } });

    expect(selection).toMatchObject({ source: "default", extended: false, legacy: false });
    expect(selection.profile.id).toBe(DEFAULT_PROFILE_ID);
  });

  it("selects the rule's profile and records the rule", () => {
    const selection = selectRecordingProfile({
      state: v2State({ rules: [qaRule] }),
      page: { url: stage },
      requestedProfileId: AUTO_PROFILE_ID
    });

    expect(selection.profile.id).toBe(BUILT_IN_PROFILE_IDS.qa);
    expect(selection).toMatchObject({
      source: "rule",
      rule: { id: "stage-qa", name: "Stage" },
      extended: true
    });
    expect(toArchivedProfileInfo(selection)).toEqual({
      id: BUILT_IN_PROFILE_IDS.qa,
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
    expect(selection.profile.id).toBe(BUILT_IN_PROFILE_IDS.lite);
  });

  it("downgrades an extended profile to Full on a foreign host", () => {
    const selection = selectRecordingProfile({
      state: v2State({ rules: [qaRule] }),
      page: { url: foreign },
      requestedProfileId: BUILT_IN_PROFILE_IDS.fullCapture
    });

    expect(selection.profile.id).toBe(BUILT_IN_PROFILE_IDS.full);
    expect(selection.extended).toBe(false);
    // Map references survive the downgrade; embedding the site's source maps does not.
    expect(selection.profile.sourceMaps).toEqual({ mode: "metadata" });
    expect(selection.downgradedFrom).toEqual({
      id: BUILT_IN_PROFILE_IDS.fullCapture,
      name: "Full capture",
      reason: "host-not-allowed"
    });
  });

  it("allows extended profiles on rule hosts, extended hosts and the enterprise allowlist", () => {
    const pick = (state: ProfilesState, url: string, allowlist: string[] = []) =>
      selectRecordingProfile({
        state,
        page: { url },
        requestedProfileId: BUILT_IN_PROFILE_IDS.qa,
        enterpriseSiteAllowlist: allowlist
      }).profile.id;

    expect(pick(v2State({ rules: [qaRule] }), stage)).toBe(BUILT_IN_PROFILE_IDS.qa);
    expect(pick(v2State({ extendedCaptureHosts: ["localhost:*"] }), "http://localhost:5173/")).toBe(
      BUILT_IN_PROFILE_IDS.qa
    );
    expect(pick(v2State(), foreign, ["https://mail.example.org"])).toBe(BUILT_IN_PROFILE_IDS.qa);
    expect(pick(v2State({ rules: [{ ...qaRule, enabled: false }] }), stage)).toBe(
      BUILT_IN_PROFILE_IDS.full
    );
    expect(
      pick(v2State({ rules: [{ ...qaRule, profileId: BUILT_IN_PROFILE_IDS.fullCapture }] }), stage)
    ).toBe(BUILT_IN_PROFILE_IDS.full);
  });

  it("keeps a v1-only Default exactly as today, but still gates presets", () => {
    const state = resolveProfilesState({
      rawProfilesStore: undefined,
      rawLegacyOptions: LEGACY_FIXTURES["harness capture policy"]
    });
    const legacyDefault = selectRecordingProfile({ state, page: { url: foreign } });
    const qa = selectRecordingProfile({
      state,
      page: { url: foreign },
      requestedProfileId: BUILT_IN_PROFILE_IDS.qa
    });

    expect(legacyDefault).toMatchObject({ legacy: true, extended: false });
    expect(legacyDefault.profile.categories.console).toBe("allow");
    expect(qa.profile.id).toBe(BUILT_IN_PROFILE_IDS.full);
  });

  it("treats an edited Default above Full as extended once v2 exists", () => {
    const raised = {
      ...createDefaultProfile(),
      categories: { ...createDefaultProfile().categories, console: "allow" as const }
    };
    const selection = selectRecordingProfile({
      state: v2State({ profiles: [raised] }),
      page: { url: foreign }
    });

    expect(selection.downgradedFrom?.id).toBe(DEFAULT_PROFILE_ID);
  });

  it("keeps the profile's redaction and lower levels when it is downgraded", () => {
    const raised = {
      ...createDefaultProfile(),
      categories: {
        ...createDefaultProfile().categories,
        console: "allow" as const,
        dom: "off" as const
      },
      redaction: { ...DEFAULT_REDACTION_PROFILE, blockedSelectors: [".my-secret"] },
      recorder: { ringBufferMinutes: 3 },
      unmaskSelectors: [".order-id"]
    };
    const selection = selectRecordingProfile({
      state: v2State({ profiles: [raised] }),
      page: { url: foreign }
    });

    expect(selection.profile.id).toBe(BUILT_IN_PROFILE_IDS.full);
    expect(selection.profile.categories.console).toBe(
      preset(BUILT_IN_PROFILE_IDS.full).categories.console
    );
    expect(selection.profile.categories.dom).toBe("off");
    expect(selection.profile.redaction.blockedSelectors).toEqual([".my-secret"]);
    expect(selection.profile.recorder.ringBufferMinutes).toBe(3);
    expect(selection.profile.unmaskSelectors).toEqual([]);
    expect(isExtendedCaptureProfile(selection.profile)).toBe(false);
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

    expect(selection.profile.id).toBe(BUILT_IN_PROFILE_IDS.lite);
    expect(selection.rule?.id).toBe("lite");
  });

  it("ignores unknown explicit ids and rules to missing profiles", () => {
    const selection = selectRecordingProfile({
      state: v2State({ rules: [{ ...qaRule, profileId: "ghost" }] }),
      page: { url: stage },
      requestedProfileId: "nope"
    });

    expect(selection).toMatchObject({ source: "default" });
    expect(selection.profile.id).toBe(DEFAULT_PROFILE_ID);
  });
});

describe("resolveProfileExportRequirements", () => {
  it("is permissive for the Default profile and strict once any extended profile ran", () => {
    const standard = { profile: createDefaultProfile(), extended: false };
    const qa = { profile: preset(BUILT_IN_PROFILE_IDS.qa), extended: true };

    expect(resolveProfileExportRequirements([standard])).toEqual({
      requireEncryption: false,
      blockOnPrivacyFindings: false
    });
    expect(resolveProfileExportRequirements([standard, qa])).toEqual({
      requireEncryption: true,
      blockOnPrivacyFindings: true
    });
  });

  it("honours per-profile export settings", () => {
    const strict = {
      profile: {
        ...createDefaultProfile(),
        export: { encryption: "required" as const, privacyScanner: "warn" as const }
      },
      extended: false
    };

    expect(resolveProfileExportRequirements([strict])).toEqual({
      requireEncryption: true,
      blockOnPrivacyFindings: false
    });
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

  it("embeds maps for the QA and Full capture presets only", () => {
    expect(
      BUILT_IN_PROFILES.filter(
        (profile) => resolveSourceMapCapture(profile, "full").mode === "embed"
      ).map((profile) => profile.id)
    ).toEqual([BUILT_IN_PROFILE_IDS.qa, BUILT_IN_PROFILE_IDS.fullCapture]);
  });
});
