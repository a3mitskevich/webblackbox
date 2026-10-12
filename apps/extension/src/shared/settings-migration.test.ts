import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  DEFAULT_REDACTION_PROFILE,
  type CaptureMode,
  type RecorderConfig
} from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import { applyFullModeVisualCapture, resolveModeBaseConfig } from "./mode-profile.js";
import { PERFORMANCE_BUDGET_STORAGE_KEY } from "./performance-budget.js";
import { resolveStartEngine } from "./profiles/engine.js";
import {
  DEFAULT_PROFILE_ID,
  PROFILES_STORAGE_KEY,
  type RecordingProfilesStore
} from "./profiles/model.js";
import {
  CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION,
  CUSTOMISED_DEFAULT_PROFILE_NAME
} from "./profiles/preset-migration.js";
import {
  BUILT_IN_PROFILE_IDS,
  createDefaultProfile,
  duplicateProfile
} from "./profiles/presets.js";
import { buildProfileRecorderConfig, selectRecordingProfile } from "./profiles/resolve.js";
import { createDefaultProfilesStore, resolveProfilesState } from "./profiles/storage.js";
import { resolveModeRecorderConfig } from "./recorder-config.js";
import {
  LEGACY_OPTIONS_STORAGE_KEY,
  migrateSettingsStorage,
  planSettingsMigration,
  REJECTED_PROFILES_STORAGE_KEY,
  SETTINGS_VERSION,
  SETTINGS_VERSION_STORAGE_KEY,
  type SettingsMigrationPlan
} from "./settings-migration.js";

/** What the options page's General form saved: the whole normalized config plus the budget. */
const OPTIONS_PAGE_SAVE = {
  ...DEFAULT_RECORDER_CONFIG,
  optionsVersion: 1,
  ringBufferMinutes: 7,
  freezeOnError: false,
  sampling: {
    ...DEFAULT_RECORDER_CONFIG.sampling,
    mousemoveHz: 33,
    scrollHz: 9,
    screenshotIdleMs: 500,
    bodyCaptureMaxBytes: 65_536
  },
  redaction: {
    ...DEFAULT_REDACTION_PROFILE,
    blockedSelectors: [".pii", "[data-secret]"],
    redactBodyPatterns: ["pin"]
  },
  performanceBudget: {
    lcpWarnMs: 4_000,
    requestWarnMs: 900,
    errorRateWarnPct: 20,
    autoFreezeOnBreach: true
  }
};

/** What the e2e harness wrote: a raised capture policy and site body policies, no budget. */
const HARNESS_OPTIONS = {
  optionsVersion: 1,
  mode: "full",
  freezeOnNetworkFailure: false,
  freezeOnLongTaskSpike: false,
  sampling: { mousemoveHz: 20, screenshotIdleMs: 600, snapshotIntervalMs: 1_000 },
  capturePolicy: {
    ...DEFAULT_CAPTURE_POLICY,
    mode: "lab",
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
      pathAllowlist: ["/api/*"],
      pathDenylist: []
    }
  ]
};

/** A record from before `optionsVersion` existed. */
const PRE_VERSION_OPTIONS = {
  sampling: { screenshotIdleMs: 0, domFlushMs: 250 }
};

const V1_SHAPES: Record<string, Record<string, unknown>> = {
  "options page save": OPTIONS_PAGE_SAVE,
  "e2e harness": HARNESS_OPTIONS,
  "pre-version record": PRE_VERSION_OPTIONS
};

const MODES: CaptureMode[] = ["lite", "full"];
const RECORDER_CONFIG_KEYS = Object.keys(DEFAULT_RECORDER_CONFIG) as Array<keyof RecorderConfig>;

/** Storage after the plan ran. */
function applyPlan(
  values: Record<string, unknown>,
  plan: SettingsMigrationPlan | null
): Record<string, unknown> {
  if (!plan) {
    return values;
  }

  return Object.fromEntries(
    Object.entries({ ...values, ...structuredClone(plan.set) }).filter(
      ([key]) => !plan.remove.includes(key)
    )
  );
}

function migrate(values: Record<string, unknown>): Record<string, unknown> {
  return applyPlan(values, planSettingsMigration(values));
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

/** The config the removed v1 read path built (`loadRecorderConfig` + visual capture). */
function v1RecorderConfig(mode: CaptureMode, stored: unknown): RecorderConfig {
  return applyFullModeVisualCapture(
    resolveModeRecorderConfig(mode, resolveModeBaseConfig(mode), stored),
    mode,
    undefined
  );
}

function storedDefaultProfile(values: Record<string, unknown>) {
  return resolveProfilesState({ rawProfilesStore: values[PROFILES_STORAGE_KEY] }).catalog.find(
    (profile) => profile.id === DEFAULT_PROFILE_ID
  );
}

describe("planSettingsMigration on real v1 shapes", () => {
  for (const [label, v1] of Object.entries(V1_SHAPES)) {
    describe(label, () => {
      const migrated = migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: structuredClone(v1) });

      it("removes v1 options and marks the settings current", () => {
        expect(migrated[LEGACY_OPTIONS_STORAGE_KEY]).toBeUndefined();
        expect(migrated[SETTINGS_VERSION_STORAGE_KEY]).toBe(SETTINGS_VERSION);
        expect(migrated[REJECTED_PROFILES_STORAGE_KEY]).toBeUndefined();
      });

      for (const mode of MODES) {
        it(`records with the config v1 gave (${mode})`, () => {
          const profile = storedDefaultProfile(migrated);

          expect(profile).toBeDefined();
          expect(
            pickRecorderConfig(buildProfileRecorderConfig({ mode, profile: profile! }))
          ).toEqual(pickRecorderConfig(v1RecorderConfig(mode, v1)));
        });
      }

      it("is idempotent", () => {
        expect(planSettingsMigration(migrated)).toBeNull();
        expect(migrate(migrated)).toEqual(migrated);
      });
    });
  }

  it("moves the options page's performance budget to its own key", () => {
    const migrated = migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE });

    expect(migrated[PERFORMANCE_BUDGET_STORAGE_KEY]).toEqual(OPTIONS_PAGE_SAVE.performanceBudget);
  });

  it("keeps the v1 sampling, freeze, redaction and site policies on the Default profile", () => {
    const fromPage = storedDefaultProfile(
      migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE })
    );
    const fromHarness = storedDefaultProfile(
      migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: HARNESS_OPTIONS })
    );

    expect(fromPage).toMatchObject({
      sampling: { mousemoveHz: 33, scrollHz: 9, screenshotIdleMs: 500 },
      recorder: { freezeOnError: false },
      redaction: { blockedSelectors: [".pii", "[data-secret]"], redactBodyPatterns: ["pin"] }
    });
    expect(fromHarness?.sitePolicies).toEqual(HARNESS_OPTIONS.sitePolicies);
    expect(fromHarness?.categories).toMatchObject({ console: "allow", cdp: "full" });
    expect(fromHarness?.basePolicy?.captureContext).toBe("synthetic");
  });

  it("keeps a customised Default as a Lite-capable user profile and records with Maximum", () => {
    const migrated = migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE });
    const state = resolveProfilesState({ rawProfilesStore: migrated[PROFILES_STORAGE_KEY] });
    const selection = selectRecordingProfile({ state, page: { url: "https://shop.example.com/" } });
    const kept = storedDefaultProfile(migrated);

    expect(selection?.profile.id).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(kept?.name).toBe(CUSTOMISED_DEFAULT_PROFILE_NAME);
    expect(kept && resolveStartEngine("lite", kept)).toBe("lite");
  });

  it("drops a Default migrated from v1 options that changed nothing", () => {
    const migrated = migrate({
      [LEGACY_OPTIONS_STORAGE_KEY]: { optionsVersion: 1, capturePolicy: DEFAULT_CAPTURE_POLICY }
    });
    const store = migrated[PROFILES_STORAGE_KEY] as { defaultProfileId: string; profiles: [] };

    expect(store.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(store.profiles).toEqual([]);
    expect(planSettingsMigration(migrated)).toBeNull();
  });

  it("writes no budget when v1 had none: the defaults apply, as before", () => {
    const migrated = migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: HARNESS_OPTIONS });

    expect(migrated[PERFORMANCE_BUDGET_STORAGE_KEY]).toBeUndefined();
  });
});

describe("planSettingsMigration with stored profiles", () => {
  const mine = duplicateProfile(createDefaultProfile(), { id: "mine", name: "Mine" });
  const savedStore = {
    ...createDefaultProfilesStore(),
    defaultProfileId: "mine",
    profiles: [mine]
  };

  it("keeps a valid profiles store: it already drove recording", () => {
    const migrated = migrate({
      [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE,
      [PROFILES_STORAGE_KEY]: savedStore
    });

    expect(migrated[PROFILES_STORAGE_KEY]).toEqual(savedStore);
    expect(migrated[PERFORMANCE_BUDGET_STORAGE_KEY]).toEqual(OPTIONS_PAGE_SAVE.performanceBudget);
    expect(migrated[LEGACY_OPTIONS_STORAGE_KEY]).toBeUndefined();
  });

  it("replaces a corrupt store with the v1 Default and keeps the corrupt one aside", () => {
    const corrupt = { schemaVersion: 2, profiles: "broken" };
    const migrated = migrate({
      [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE,
      [PROFILES_STORAGE_KEY]: corrupt
    });

    expect(migrated[REJECTED_PROFILES_STORAGE_KEY]).toEqual(corrupt);
    expect(storedDefaultProfile(migrated)?.recorder).toEqual({ freezeOnError: false });
    expect(planSettingsMigration(migrated)).toBeNull();
  });

  it("does not overwrite a budget already stored under its own key", () => {
    const budget = { lcpWarnMs: 1_000, requestWarnMs: 200, errorRateWarnPct: 5 };
    const migrated = migrate({
      [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE,
      [PERFORMANCE_BUDGET_STORAGE_KEY]: budget
    });

    expect(migrated[PERFORMANCE_BUDGET_STORAGE_KEY]).toEqual(budget);
  });
});

describe("planSettingsMigration to the built-in presets (version 2)", () => {
  const mine = duplicateProfile(createDefaultProfile(), { id: "mine", name: "Mine" });
  const customised = {
    ...createDefaultProfile(),
    sampling: { scrollHz: 7 }
  };
  const ruleTo = (id: string, profileId: string) => ({
    id,
    profileId,
    priority: 1,
    enabled: true,
    match: { hosts: [`${id}.example.com`] }
  });
  const v1Store = (partial: Record<string, unknown>) => ({
    schemaVersion: 2,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: [createDefaultProfile()],
    rules: [],
    extendedCaptureHosts: [],
    ...partial
  });
  const migrateV1 = (store: Record<string, unknown>) =>
    migrate({ [SETTINGS_VERSION_STORAGE_KEY]: 1, [PROFILES_STORAGE_KEY]: store });

  it("points the default and rules of removed presets at Maximum", () => {
    const migrated = migrateV1(
      v1Store({
        defaultProfileId: "builtin:qa",
        profiles: [mine],
        rules: [
          ruleTo("full", "builtin:full"),
          ruleTo("qa", "builtin:qa"),
          ruleTo("capture", "builtin:full-capture"),
          ruleTo("lite", BUILT_IN_PROFILE_IDS.lite),
          ruleTo("mine", "mine")
        ]
      })
    );
    const store = migrated[PROFILES_STORAGE_KEY] as RecordingProfilesStore;

    expect(migrated[SETTINGS_VERSION_STORAGE_KEY]).toBe(SETTINGS_VERSION);
    expect(store.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(store.rules.map((rule) => [rule.id, rule.profileId])).toEqual([
      ["full", BUILT_IN_PROFILE_IDS.maximum],
      ["qa", BUILT_IN_PROFILE_IDS.maximum],
      ["capture", BUILT_IN_PROFILE_IDS.maximum],
      ["lite", BUILT_IN_PROFILE_IDS.lite],
      ["mine", "mine"]
    ]);
    expect(store.profiles).toEqual([mine]);
  });

  it("drops an untouched Default and points its rules at Maximum", () => {
    const migrated = migrateV1(v1Store({ rules: [ruleTo("default", DEFAULT_PROFILE_ID)] }));
    const store = migrated[PROFILES_STORAGE_KEY] as RecordingProfilesStore;

    expect(store.profiles).toEqual([]);
    expect(store.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(store.rules[0]?.profileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
  });

  it("keeps a customised Default as a user profile and makes Maximum the default", () => {
    const migrated = migrateV1(
      v1Store({ profiles: [customised], rules: [ruleTo("default", DEFAULT_PROFILE_ID)] })
    );
    const store = migrated[PROFILES_STORAGE_KEY] as RecordingProfilesStore;

    expect(store.profiles).toEqual([
      {
        ...customised,
        name: CUSTOMISED_DEFAULT_PROFILE_NAME,
        description: CUSTOMISED_DEFAULT_PROFILE_DESCRIPTION
      }
    ]);
    expect(store.defaultProfileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(store.rules[0]?.profileId).toBe(DEFAULT_PROFILE_ID);
  });

  it("keeps a user profile chosen as the default", () => {
    const migrated = migrateV1(
      v1Store({ defaultProfileId: "mine", profiles: [createDefaultProfile(), mine] })
    );
    const store = migrated[PROFILES_STORAGE_KEY] as RecordingProfilesStore;

    expect(store.defaultProfileId).toBe("mine");
    expect(store.profiles).toEqual([mine]);
  });

  it("lists deleted recommended profiles with the new ids only", () => {
    const migrated = migrateV1(
      v1Store({
        removedRecommendedProfileIds: [DEFAULT_PROFILE_ID, "builtin:qa", BUILT_IN_PROFILE_IDS.lite]
      })
    );
    const store = migrated[PROFILES_STORAGE_KEY] as RecordingProfilesStore;

    expect(store.removedRecommendedProfileIds).toEqual([BUILT_IN_PROFILE_IDS.lite]);
  });

  it("keeps a store with rows the reader dropped aside before rewriting it", () => {
    const raw = v1Store({
      profiles: [createDefaultProfile(), { ...mine, categories: { console: "everything" } }]
    });
    const migrated = migrateV1(raw);

    expect(migrated[REJECTED_PROFILES_STORAGE_KEY]).toEqual(raw);
    expect((migrated[PROFILES_STORAGE_KEY] as RecordingProfilesStore).profiles).toEqual([]);
  });

  it("leaves a store without old presets untouched and only marks the version", () => {
    const store = { ...createDefaultProfilesStore(), defaultProfileId: "mine", profiles: [mine] };

    expect(
      planSettingsMigration({ [SETTINGS_VERSION_STORAGE_KEY]: 1, [PROFILES_STORAGE_KEY]: store })
    ).toEqual({ set: { [SETTINGS_VERSION_STORAGE_KEY]: SETTINGS_VERSION }, remove: [] });
  });

  it("is idempotent and does nothing at version 2", () => {
    const migrated = migrateV1(
      v1Store({ defaultProfileId: "builtin:full", profiles: [customised] })
    );

    expect(SETTINGS_VERSION).toBe(2);
    expect(planSettingsMigration(migrated)).toBeNull();
    expect(
      planSettingsMigration({
        [SETTINGS_VERSION_STORAGE_KEY]: 2,
        [PROFILES_STORAGE_KEY]: v1Store({ defaultProfileId: "builtin:qa" })
      })
    ).toBeNull();
  });
});

describe("planSettingsMigration edge cases", () => {
  it("only marks a fresh install current", () => {
    expect(planSettingsMigration({})).toEqual({
      set: { [SETTINGS_VERSION_STORAGE_KEY]: SETTINGS_VERSION },
      remove: []
    });
  });

  it("drops a v1 value that is not a record", () => {
    const migrated = migrate({ [LEGACY_OPTIONS_STORAGE_KEY]: "garbage" });

    expect(migrated).toEqual({ [SETTINGS_VERSION_STORAGE_KEY]: SETTINGS_VERSION });
  });

  it("only removes v1 options written after the migration", () => {
    expect(
      planSettingsMigration({
        [SETTINGS_VERSION_STORAGE_KEY]: SETTINGS_VERSION,
        [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE
      })
    ).toEqual({ set: {}, remove: [LEGACY_OPTIONS_STORAGE_KEY] });
  });
});

describe("migrateSettingsStorage", () => {
  function fakeArea(initial: Record<string, unknown>, options: { failSet?: boolean } = {}) {
    const data: Record<string, unknown> = { ...initial };
    const area = {
      get: vi.fn(async (keys: string[]) =>
        Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]))
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        if (options.failSet) {
          throw new Error("quota exceeded");
        }

        Object.assign(data, structuredClone(items));
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          Reflect.deleteProperty(data, key);
        }
      })
    };
    return { data, area };
  }

  it("migrates once and then reports the settings current", async () => {
    const { data, area } = fakeArea({ [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE });

    await expect(migrateSettingsStorage(area)).resolves.toEqual({ status: "migrated" });
    await expect(migrateSettingsStorage(area)).resolves.toEqual({ status: "current" });
    expect(data[LEGACY_OPTIONS_STORAGE_KEY]).toBeUndefined();
    expect(storedDefaultProfile(data)?.sampling.mousemoveHz).toBe(33);
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it("keeps v1 options and stays unmarked when the write fails, so the next start retries", async () => {
    const { data, area } = fakeArea(
      { [LEGACY_OPTIONS_STORAGE_KEY]: OPTIONS_PAGE_SAVE },
      { failSet: true }
    );

    await expect(migrateSettingsStorage(area)).resolves.toEqual({
      status: "failed",
      error: "quota exceeded"
    });
    expect(area.remove).not.toHaveBeenCalled();
    expect(data[LEGACY_OPTIONS_STORAGE_KEY]).toEqual(OPTIONS_PAGE_SAVE);
    expect(data[SETTINGS_VERSION_STORAGE_KEY]).toBeUndefined();
  });

  it("does nothing without a storage area", async () => {
    await expect(migrateSettingsStorage(undefined)).resolves.toEqual({ status: "current" });
  });
});
