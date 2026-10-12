import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_DATA_SETTINGS,
  isDefaultLocalDataSettings,
  resolveLocalDataSettings,
  resolveUnexportedRetentionMs
} from "./local-data.js";
import { recordingProfileSchema, type RecordingProfile } from "./model.js";
import { BUILT_IN_PROFILE_IDS, BUILT_IN_PROFILES, findBuiltInProfile } from "./presets.js";
import { parseManagedProfilesPolicy } from "./storage.js";

function maximumPreset(): RecordingProfile {
  const preset = findBuiltInProfile(BUILT_IN_PROFILE_IDS.maximum);

  if (!preset) {
    throw new Error("Maximum preset is missing");
  }

  return preset;
}

describe("profile local data settings", () => {
  it("deletes after export and keeps unexported recordings until exported by default", () => {
    expect(DEFAULT_LOCAL_DATA_SETTINGS).toEqual({ deleteAfterExport: true });
    expect(resolveLocalDataSettings({})).toEqual(DEFAULT_LOCAL_DATA_SETTINGS);
    expect(resolveUnexportedRetentionMs({})).toBeNull();
    expect(isDefaultLocalDataSettings(resolveLocalDataSettings({}))).toBe(true);
  });

  it("keeps every built-in profile's recordings until they are exported", () => {
    for (const preset of BUILT_IN_PROFILES) {
      expect(preset.localData).toBeUndefined();
      expect(resolveUnexportedRetentionMs(preset)).toBeNull();
    }
  });

  it("keeps a retention a profile sets", () => {
    const profile = {
      localData: { deleteAfterExport: false, unexportedRetentionMinutes: 5 }
    };

    expect(resolveUnexportedRetentionMs(profile)).toBe(5 * 60_000);
    expect(isDefaultLocalDataSettings(resolveLocalDataSettings(profile))).toBe(false);
  });

  it("accepts profiles without the block and bounds the retention", () => {
    const withoutLocalData = Object.fromEntries(
      Object.entries(maximumPreset()).filter(([key]) => key !== "localData")
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
    // No retention: kept until exported or deleted.
    expect(
      recordingProfileSchema.safeParse({
        ...withoutLocalData,
        localData: { deleteAfterExport: true }
      }).success
    ).toBe(true);
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
    expect(byId("managed:partial")?.localData).toEqual({ deleteAfterExport: false });
    expect(byId("managed:plain")?.localData).toBeUndefined();
  });
});
