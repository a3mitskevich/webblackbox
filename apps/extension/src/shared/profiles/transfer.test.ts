import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_ID,
  PROFILES_SCHEMA_VERSION,
  type RecordingProfilesStore
} from "./model.js";
import { CUSTOMISED_DEFAULT_PROFILE_NAME } from "./preset-migration.js";
import { BUILT_IN_PROFILE_IDS, createDefaultProfile, duplicateProfile } from "./presets.js";
import {
  createProfilesExportFile,
  MAX_PROFILES_IMPORT_BYTES,
  PROFILES_EXPORT_FORMAT,
  PROFILES_EXPORT_PRESETS_VERSION,
  previewProfilesImport
} from "./transfer.js";

const STAGE_PROFILE = duplicateProfile(createDefaultProfile(), { id: "stage", name: "Stage" });
const TEAM_PROFILE = duplicateProfile(createDefaultProfile(), { id: "team", name: "Team" });
const STAGE_RULE = {
  id: "stage-rule",
  name: "Stage hosts",
  profileId: BUILT_IN_PROFILE_IDS.maximum,
  priority: 10,
  enabled: true,
  match: { hosts: ["*.stage.example.com"] }
};

function store(partial: Partial<RecordingProfilesStore> = {}): RecordingProfilesStore {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: BUILT_IN_PROFILE_IDS.maximum,
    profiles: [STAGE_PROFILE],
    rules: [],
    extendedCaptureHosts: [],
    ...partial
  };
}

function exported(partial: Partial<RecordingProfilesStore>): string {
  return JSON.stringify(
    createProfilesExportFile(store(partial), new Date("2026-10-03T00:00:00.000Z"))
  );
}

/** An export of an earlier version: the same file without the presets version marker. */
function exportedByEarlierVersion(partial: Partial<RecordingProfilesStore>): string {
  const file = JSON.parse(exported(partial)) as Record<string, unknown>;

  return JSON.stringify(
    Object.fromEntries(Object.entries(file).filter(([key]) => key !== "presetsVersion"))
  );
}

describe("createProfilesExportFile", () => {
  it("wraps the store with a format marker", () => {
    const file = createProfilesExportFile(store(), new Date("2026-10-03T00:00:00.000Z"));

    expect(file).toMatchObject({
      format: PROFILES_EXPORT_FORMAT,
      exportedAt: "2026-10-03T00:00:00.000Z",
      presetsVersion: PROFILES_EXPORT_PRESETS_VERSION,
      schemaVersion: 2,
      defaultProfileId: BUILT_IN_PROFILE_IDS.maximum
    });
  });
});

describe("previewProfilesImport", () => {
  it("round-trips an export without changes", () => {
    const current = store({
      profiles: [TEAM_PROFILE, STAGE_PROFILE],
      rules: [STAGE_RULE]
    });
    const preview = previewProfilesImport(
      JSON.stringify(createProfilesExportFile(current)),
      current
    );

    expect(preview.ok).toBe(true);
    expect(preview.ok && preview.diff.hasChanges).toBe(false);
    expect(preview.ok && preview.next).toEqual(current);
  });

  it("reports added, removed and changed profiles and rules", () => {
    const current = store({
      profiles: [TEAM_PROFILE, { ...STAGE_PROFILE, name: "Old stage" }],
      rules: [{ ...STAGE_RULE, id: "gone", name: "Gone" }],
      extendedCaptureHosts: ["old.test"]
    });
    const incoming = exported({
      defaultProfileId: "stage",
      profiles: [
        TEAM_PROFILE,
        STAGE_PROFILE,
        duplicateProfile(STAGE_PROFILE, { id: "new", name: "New" })
      ],
      rules: [STAGE_RULE],
      extendedCaptureHosts: ["localhost:*"]
    });
    const preview = previewProfilesImport(incoming, current);

    expect(preview.ok).toBe(true);

    if (!preview.ok) {
      return;
    }

    expect(preview.diff.profiles).toEqual({
      added: [{ id: "new", name: "New" }],
      removed: [],
      changed: [{ id: "stage", name: "Stage", fields: ["name"] }],
      unchanged: 1
    });
    expect(preview.diff.rules).toEqual({
      added: [{ id: "stage-rule", name: "Stage hosts" }],
      removed: [{ id: "gone", name: "Gone" }],
      changed: [],
      unchanged: 0
    });
    expect(preview.diff.defaultProfileId).toEqual({
      from: BUILT_IN_PROFILE_IDS.maximum,
      to: "stage"
    });
    expect(preview.diff.extendedCaptureHosts).toEqual({
      added: ["localhost:*"],
      removed: ["old.test"]
    });
    expect(preview.diff.hasChanges).toBe(true);
  });

  it("rejects non-JSON, foreign and oversized files", () => {
    expect(previewProfilesImport("{nope", store())).toEqual({
      ok: false,
      error: "File is not valid JSON."
    });
    expect(previewProfilesImport(JSON.stringify(store()), store())).toMatchObject({ ok: false });
    expect(previewProfilesImport(" ".repeat(MAX_PROFILES_IMPORT_BYTES + 1), store())).toMatchObject(
      { ok: false, error: expect.stringContaining("too large") }
    );
  });

  it("rejects the whole file when any row is invalid", () => {
    const file = JSON.parse(exported({ rules: [STAGE_RULE] })) as Record<string, unknown>;
    const broken = {
      ...file,
      rules: [STAGE_RULE, { ...STAGE_RULE, id: "bad", match: { titleRegex: "(" } }]
    };
    const preview = previewProfilesImport(JSON.stringify(broken), store());

    expect(preview).toMatchObject({ ok: false, error: expect.stringContaining("rule #2") });
  });

  it("keeps rules and a default that point to deleted profiles, as the store does", () => {
    // Deleting a profile keeps its rules (skipped and flagged until it exists again), and deleting
    // every profile keeps the default id: such a store must survive its own export.
    const orphanRule = { ...STAGE_RULE, profileId: "ghost" };
    const withOrphanRule = store({ rules: [orphanRule] });
    const ruleRoundTrip = previewProfilesImport(exported({ rules: [orphanRule] }), withOrphanRule);

    expect(ruleRoundTrip.ok && ruleRoundTrip.next).toEqual(withOrphanRule);

    const emptied = store({
      defaultProfileId: "ghost",
      profiles: [],
      removedRecommendedProfileIds: [BUILT_IN_PROFILE_IDS.maximum, BUILT_IN_PROFILE_IDS.lite]
    });
    const emptyRoundTrip = previewProfilesImport(
      JSON.stringify(createProfilesExportFile(emptied)),
      emptied
    );

    expect(emptyRoundTrip.ok && emptyRoundTrip.next).toEqual(emptied);
  });

  it("moves an export of an earlier version to the built-in Maximum and Light", () => {
    const legacy = exportedByEarlierVersion({
      defaultProfileId: DEFAULT_PROFILE_ID,
      profiles: [createDefaultProfile(), STAGE_PROFILE],
      rules: [{ ...STAGE_RULE, profileId: "builtin:qa" }],
      removedRecommendedProfileIds: ["builtin:full", BUILT_IN_PROFILE_IDS.lite]
    });
    const preview = previewProfilesImport(legacy, store());

    expect(preview.ok && preview.next).toEqual(
      store({
        rules: [{ ...STAGE_RULE, profileId: BUILT_IN_PROFILE_IDS.maximum }],
        removedRecommendedProfileIds: [BUILT_IN_PROFILE_IDS.lite]
      })
    );
  });

  it("drops an untouched Default of an earlier version's export, a customised one is kept", () => {
    const customised = { ...createDefaultProfile(), sampling: { scrollHz: 3 } };
    const pristine = previewProfilesImport(
      exportedByEarlierVersion({
        defaultProfileId: DEFAULT_PROFILE_ID,
        profiles: [createDefaultProfile()],
        rules: [{ ...STAGE_RULE, profileId: DEFAULT_PROFILE_ID }]
      }),
      store()
    );
    const kept = previewProfilesImport(
      exportedByEarlierVersion({ profiles: [customised] }),
      store()
    );

    expect(pristine.ok && pristine.next.profiles).toEqual([]);
    expect(pristine.ok && pristine.next.rules[0]?.profileId).toBe(BUILT_IN_PROFILE_IDS.maximum);
    expect(kept.ok && kept.next.profiles[0]?.name).toBe(CUSTOMISED_DEFAULT_PROFILE_NAME);
  });

  it("imports its own export as it is: a kept Default stays the default and keeps its rules", () => {
    // A kept "Default (custom)", reset to the old defaults and then chosen as the default again:
    // migrating the file would drop it and repoint its rule.
    const keptDefault = {
      ...createDefaultProfile(),
      name: CUSTOMISED_DEFAULT_PROFILE_NAME
    };
    const current = store({
      defaultProfileId: DEFAULT_PROFILE_ID,
      profiles: [keptDefault, STAGE_PROFILE],
      rules: [{ ...STAGE_RULE, profileId: DEFAULT_PROFILE_ID }]
    });
    const preview = previewProfilesImport(
      JSON.stringify(createProfilesExportFile(current)),
      current
    );

    expect(preview.ok && preview.next).toEqual(current);
    expect(preview.ok && preview.diff.hasChanges).toBe(false);
  });

  it("carries deleted recommended profiles and reports restoring or deleting them", () => {
    const withoutLight = store({ removedRecommendedProfileIds: [BUILT_IN_PROFILE_IDS.lite] });
    const file = createProfilesExportFile(withoutLight);
    const roundTrip = previewProfilesImport(JSON.stringify(file), withoutLight);

    expect(file.removedRecommendedProfileIds).toEqual([BUILT_IN_PROFILE_IDS.lite]);
    expect(roundTrip.ok && roundTrip.next).toEqual(withoutLight);
    expect(roundTrip.ok && roundTrip.diff.hasChanges).toBe(false);

    const deleting = previewProfilesImport(JSON.stringify(file), store());
    expect(deleting.ok && deleting.diff.removedRecommendedProfileIds).toEqual({
      from: [],
      to: [BUILT_IN_PROFILE_IDS.lite]
    });
    expect(deleting.ok && deleting.diff.hasChanges).toBe(true);
    expect("removedRecommendedProfileIds" in createProfilesExportFile(store())).toBe(false);
  });
});
