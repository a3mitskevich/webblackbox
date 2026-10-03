import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_POLICY_PREFS,
  EXPORT_POLICY_PREFS_STORAGE_KEY,
  loadExportPolicyPrefs,
  normalizeExportPolicyPrefs,
  saveExportPolicyPrefs,
  toExportPolicy
} from "./export-policy-prefs.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
}

describe("export policy prefs", () => {
  it("defaults to 100 MB, 20 minutes and sensitive-finding alerts", () => {
    expect(loadExportPolicyPrefs(memoryStorage())).toEqual({
      alertSensitiveFindings: true,
      maxArchiveMb: 100,
      recentMinutes: 20
    });
  });

  it("reads text values the previous popup stored and clamps them", () => {
    const storage = memoryStorage({
      [EXPORT_POLICY_PREFS_STORAGE_KEY]: JSON.stringify({
        alertSensitiveFindings: false,
        maxArchiveMb: "99999",
        recentMinutes: " 45 "
      })
    });

    expect(loadExportPolicyPrefs(storage)).toEqual({
      alertSensitiveFindings: false,
      maxArchiveMb: 4096,
      recentMinutes: 45
    });
  });

  it("falls back to defaults for corrupt or non-positive values", () => {
    expect(
      loadExportPolicyPrefs(memoryStorage({ [EXPORT_POLICY_PREFS_STORAGE_KEY]: "{" }))
    ).toEqual(DEFAULT_EXPORT_POLICY_PREFS);
    expect(normalizeExportPolicyPrefs({ maxArchiveMb: -3, recentMinutes: "abc" })).toEqual(
      DEFAULT_EXPORT_POLICY_PREFS
    );
  });

  it("round-trips through storage and reports refused writes", () => {
    const storage = memoryStorage();

    expect(
      saveExportPolicyPrefs(
        { alertSensitiveFindings: false, maxArchiveMb: 8, recentMinutes: 5 },
        storage
      )
    ).toBe(true);
    expect(loadExportPolicyPrefs(storage)).toEqual({
      alertSensitiveFindings: false,
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
      recentWindowMs: 20 * 60 * 1000
    });
    expect(toExportPolicy(DEFAULT_EXPORT_POLICY_PREFS, "none")).toEqual(
      expect.objectContaining({ includeScreenshots: false, includeScreenRecordings: false })
    );
  });
});
