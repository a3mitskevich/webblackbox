import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_POLICY_PREFS,
  EXPORT_POLICY_PREFS_STORAGE_KEY,
  exportsWholeSession,
  loadExportPolicyPrefs,
  normalizeExportPolicyPrefs,
  saveExportPolicyPrefs,
  toExportPolicy
} from "./export-policy-prefs.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
}

function legacyStorage(value: Record<string, unknown>) {
  return memoryStorage({ [EXPORT_POLICY_PREFS_STORAGE_KEY]: JSON.stringify(value) });
}

describe("export policy prefs", () => {
  it("exports the whole session by default: no size cap, no recent window", () => {
    const prefs = loadExportPolicyPrefs(memoryStorage());

    expect(prefs).toEqual({ maxArchiveMb: 0, recentMinutes: 0 });
    expect(exportsWholeSession(prefs)).toBe(true);
    expect(toExportPolicy(prefs, "none")).toMatchObject({
      maxArchiveBytes: null,
      recentWindowMs: null
    });
  });

  it("migrates legacy prefs that merely equal the old defaults to the whole session", () => {
    const storage = legacyStorage({ maxArchiveMb: 100, recentMinutes: 20 });

    expect(loadExportPolicyPrefs(storage)).toEqual({ maxArchiveMb: 0, recentMinutes: 0 });
    // Written back in the current format: a later 100 MB / 20 min choice is the user's own.
    expect(JSON.parse(storage.data.get(EXPORT_POLICY_PREFS_STORAGE_KEY) ?? "{}")).toEqual({
      version: 2,
      maxArchiveMb: 0,
      recentMinutes: 0
    });
    expect(saveExportPolicyPrefs({ maxArchiveMb: 100, recentMinutes: 20 }, storage)).toBe(true);
    expect(loadExportPolicyPrefs(storage)).toEqual({ maxArchiveMb: 100, recentMinutes: 20 });
  });

  it("keeps customised legacy values and turns off only the untouched ones", () => {
    expect(loadExportPolicyPrefs(legacyStorage({ maxArchiveMb: 250, recentMinutes: 20 }))).toEqual({
      maxArchiveMb: 250,
      recentMinutes: 0
    });
    expect(loadExportPolicyPrefs(legacyStorage({ maxArchiveMb: 100, recentMinutes: 5 }))).toEqual({
      maxArchiveMb: 0,
      recentMinutes: 5
    });
    // A missing legacy field meant the old default.
    expect(loadExportPolicyPrefs(legacyStorage({ recentMinutes: 45 }))).toEqual({
      maxArchiveMb: 0,
      recentMinutes: 45
    });
  });

  it("reads text values the previous popup stored, clamps them and drops retired fields", () => {
    const storage = legacyStorage({
      alertSensitiveFindings: false,
      maxArchiveMb: "99999",
      recentMinutes: " 45 "
    });

    // Scanner findings are always shown inline: the old alert switch is ignored.
    expect(loadExportPolicyPrefs(storage)).toEqual({
      maxArchiveMb: 4096,
      recentMinutes: 45
    });
  });

  it("keeps 0 as off and falls back to defaults for corrupt or negative values", () => {
    expect(normalizeExportPolicyPrefs({ maxArchiveMb: 0, recentMinutes: "0" })).toEqual({
      maxArchiveMb: 0,
      recentMinutes: 0
    });
    expect(normalizeExportPolicyPrefs({ maxArchiveMb: 0.2, recentMinutes: 7 })).toEqual({
      maxArchiveMb: 1,
      recentMinutes: 7
    });
    expect(
      loadExportPolicyPrefs(memoryStorage({ [EXPORT_POLICY_PREFS_STORAGE_KEY]: "{" }))
    ).toEqual(DEFAULT_EXPORT_POLICY_PREFS);
    expect(normalizeExportPolicyPrefs({ maxArchiveMb: -3, recentMinutes: "abc" })).toEqual(
      DEFAULT_EXPORT_POLICY_PREFS
    );
  });

  it("round-trips through storage and reports refused writes", () => {
    const storage = memoryStorage();

    expect(saveExportPolicyPrefs({ maxArchiveMb: 8, recentMinutes: 5 }, storage)).toBe(true);
    expect(loadExportPolicyPrefs(storage)).toEqual({
      maxArchiveMb: 8,
      recentMinutes: 5
    });
    expect(
      saveExportPolicyPrefs(DEFAULT_EXPORT_POLICY_PREFS, {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        }
      })
    ).toBe(false);
  });

  it("builds the export policy with visuals from the full-mode choice", () => {
    expect(toExportPolicy({ ...DEFAULT_EXPORT_POLICY_PREFS, maxArchiveMb: 2 }, "both")).toEqual({
      includeScreenshots: true,
      includeScreenRecordings: true,
      maxArchiveBytes: 2 * 1024 * 1024,
      recentWindowMs: null
    });
    expect(toExportPolicy({ maxArchiveMb: 0, recentMinutes: 20 }, "none")).toMatchObject({
      maxArchiveBytes: null,
      recentWindowMs: 20 * 60 * 1000
    });
    expect(toExportPolicy(DEFAULT_EXPORT_POLICY_PREFS, "none")).toEqual(
      expect.objectContaining({ includeScreenshots: false, includeScreenRecordings: false })
    );
  });
});
