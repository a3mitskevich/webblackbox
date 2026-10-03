import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_ID,
  PROFILES_SCHEMA_VERSION,
  type RecordingProfilesStore
} from "./model.js";
import { BUILT_IN_PROFILE_IDS, createDefaultProfile, duplicateProfile } from "./presets.js";
import {
  createProfilesExportFile,
  MAX_PROFILES_IMPORT_BYTES,
  PROFILES_EXPORT_FORMAT,
  previewProfilesImport
} from "./transfer.js";

const STAGE_PROFILE = duplicateProfile(createDefaultProfile(), { id: "stage", name: "Stage" });
const STAGE_RULE = {
  id: "stage-rule",
  name: "Stage hosts",
  profileId: BUILT_IN_PROFILE_IDS.qa,
  priority: 10,
  enabled: true,
  match: { hosts: ["*.stage.example.com"] }
};

function store(partial: Partial<RecordingProfilesStore> = {}): RecordingProfilesStore {
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    defaultProfileId: DEFAULT_PROFILE_ID,
    profiles: [createDefaultProfile()],
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

describe("createProfilesExportFile", () => {
  it("wraps the store with a format marker", () => {
    const file = createProfilesExportFile(store(), new Date("2026-10-03T00:00:00.000Z"));

    expect(file).toMatchObject({
      format: PROFILES_EXPORT_FORMAT,
      exportedAt: "2026-10-03T00:00:00.000Z",
      schemaVersion: 2,
      defaultProfileId: DEFAULT_PROFILE_ID
    });
  });
});

describe("previewProfilesImport", () => {
  it("round-trips an export without changes", () => {
    const current = store({
      profiles: [createDefaultProfile(), STAGE_PROFILE],
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
      profiles: [createDefaultProfile(), { ...STAGE_PROFILE, name: "Old stage" }],
      rules: [{ ...STAGE_RULE, id: "gone", name: "Gone" }],
      extendedCaptureHosts: ["old.test"]
    });
    const incoming = exported({
      defaultProfileId: "stage",
      profiles: [
        createDefaultProfile(),
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
    expect(preview.diff.defaultProfileId).toEqual({ from: DEFAULT_PROFILE_ID, to: "stage" });
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

  it("rejects rules and defaults that point to missing profiles", () => {
    expect(
      previewProfilesImport(exported({ rules: [{ ...STAGE_RULE, profileId: "ghost" }] }), store())
    ).toMatchObject({ ok: false, error: expect.stringContaining('unknown profile "ghost"') });
    expect(previewProfilesImport(exported({ defaultProfileId: "ghost" }), store())).toMatchObject({
      ok: false,
      error: expect.stringContaining('Default profile "ghost"')
    });
  });
});
