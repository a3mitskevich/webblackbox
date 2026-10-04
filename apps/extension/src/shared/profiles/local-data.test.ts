import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_DATA_SETTINGS,
  isDefaultLocalDataSettings,
  resolveLocalDataSettings,
  resolveUnexportedRetentionMs
} from "./local-data.js";
import { recordingProfileSchema, type RecordingProfile } from "./model.js";
import { BUILT_IN_PROFILE_IDS, BUILT_IN_PROFILES, findBuiltInProfile } from "./presets.js";
import { downgradeExtendedSelection } from "./resolve.js";
import { parseManagedProfilesPolicy } from "./storage.js";

function fullCapturePreset(): RecordingProfile {
  const preset = findBuiltInProfile(BUILT_IN_PROFILE_IDS.fullCapture);

  if (!preset) {
    throw new Error("Full capture preset is missing");
  }

  return preset;
}

describe("profile local data settings", () => {
  it("keeps today's behaviour for profiles without the setting", () => {
    expect(DEFAULT_LOCAL_DATA_SETTINGS).toEqual({
      deleteAfterExport: true,
      unexportedRetentionMinutes: 10
    });
    expect(resolveLocalDataSettings({})).toEqual(DEFAULT_LOCAL_DATA_SETTINGS);
    expect(resolveUnexportedRetentionMs({})).toBe(10 * 60_000);
    expect(isDefaultLocalDataSettings(resolveLocalDataSettings({}))).toBe(true);
  });

  it("deletes Full capture recordings after export and keeps unexported ones for less time", () => {
    const fullCapture = fullCapturePreset();

    expect(resolveLocalDataSettings(fullCapture)).toEqual({
      deleteAfterExport: true,
      unexportedRetentionMinutes: 5
    });
    expect(resolveUnexportedRetentionMs(fullCapture)).toBeLessThan(
      resolveUnexportedRetentionMs({})
    );

    for (const preset of BUILT_IN_PROFILES.filter((entry) => entry.id !== fullCapture.id)) {
      expect(preset.localData).toBeUndefined();
    }
  });

  it("accepts profiles without the block and bounds the retention", () => {
    const withoutLocalData = Object.fromEntries(
      Object.entries(fullCapturePreset()).filter(([key]) => key !== "localData")
    );
    const withRetention = (minutes: number): Record<string, unknown> => ({
      ...withoutLocalData,
      localData: { deleteAfterExport: false, unexportedRetentionMinutes: minutes }
    });

    expect(recordingProfileSchema.safeParse(withoutLocalData).success).toBe(true);
    expect(recordingProfileSchema.safeParse(withRetention(1)).success).toBe(true);
    expect(recordingProfileSchema.safeParse(withRetention(1440)).success).toBe(true);
    expect(recordingProfileSchema.safeParse(withRetention(0)).success).toBe(false);
    expect(recordingProfileSchema.safeParse(withRetention(1441)).success).toBe(false);
    expect(recordingProfileSchema.safeParse(withRetention(2.5)).success).toBe(false);
    expect(
      recordingProfileSchema.safeParse({
        ...withoutLocalData,
        localData: { deleteAfterExport: true }
      }).success
    ).toBe(false);
  });

  it("keeps the profile's local data rules when an extended profile is downgraded", () => {
    const downgraded = downgradeExtendedSelection({
      profile: fullCapturePreset(),
      source: "explicit",
      extended: true,
      legacy: false
    });

    expect(downgraded.profile.id).toBe(BUILT_IN_PROFILE_IDS.full);
    expect(downgraded.profile.localData).toEqual(fullCapturePreset().localData);
  });

  it("completes a partial managed block and leaves an absent one absent", () => {
    const managed = parseManagedProfilesPolicy({
      profiles: [
        { id: "partial", name: "Partial", localData: { deleteAfterExport: false } },
        { id: "plain", name: "Plain" }
      ]
    });
    const byId = (id: string) => managed.profiles.find((profile) => profile.id === id);

    expect(managed.issues).toEqual([]);
    expect(byId("managed:partial")?.localData).toEqual({
      deleteAfterExport: false,
      unexportedRetentionMinutes: 10
    });
    expect(byId("managed:plain")?.localData).toBeUndefined();
  });
});
