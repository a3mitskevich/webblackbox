import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_ID,
  PROFILES_SCHEMA_VERSION,
  type RecordingProfilesStore
} from "../shared/profiles/model.js";
import { BUILT_IN_PROFILE_IDS, createDefaultProfile } from "../shared/profiles/presets.js";
import {
  applyProfileFormValues,
  createUniqueId,
  deleteProfileFromStore,
  formatQueryLines,
  parseOptionalInt,
  parseQueryLines,
  ruleFromFormValues,
  splitLines,
  type ProfileFormValues
} from "./profile-form-model.js";

const FORM: ProfileFormValues = {
  name: " Stage QA ",
  base: "full",
  categories: { console: "allow", network: "body-allowlist", inputs: "bogus" },
  blockedSelectors: ".pii\n.pii\n",
  unmaskSelectors: ".order-id",
  redactHeaders: "Authorization\nX-Token",
  redactBodyPatterns: "password",
  bodyMimeAllowlist: "Application/JSON",
  bodyMaxBytes: "65536",
  includeUrls: "",
  excludeUrls: "*/auth/*",
  mousemoveHz: "",
  visual: "screenshots",
  requireEncryption: true,
  blockOnFindings: false
};

describe("profile form model", () => {
  it("parses lines, optional numbers and query lines", () => {
    expect(splitLines(" a \n\nb\na\r\nc")).toEqual(["a", "b", "c"]);
    expect(parseOptionalInt("", 0, 10)).toBeUndefined();
    expect(parseOptionalInt("abc", 0, 10)).toBeUndefined();
    expect(parseOptionalInt("42", 0, 10)).toBe(10);
    expect(parseQueryLines("env=qa\ndebug\n=bad")).toEqual({ env: "qa", debug: true });
    expect(parseQueryLines("")).toBeUndefined();
    expect(formatQueryLines({ env: "qa", debug: true })).toBe("env=qa\ndebug");
  });

  it("applies form values to a profile and keeps unrelated settings", () => {
    const base = { ...createDefaultProfile(), sampling: { scrollHz: 9 }, visual: "none" as const };
    const next = applyProfileFormValues(base, FORM);

    expect(next).toMatchObject({
      name: "Stage QA",
      base: "full",
      categories: { console: "allow", network: "body-allowlist", inputs: "length-only" },
      unmaskSelectors: [".order-id"],
      network: {
        bodyMimeAllowlist: ["application/json"],
        bodyMaxBytes: 65536,
        includeUrls: [],
        excludeUrls: ["*/auth/*"]
      },
      visual: "screenshots",
      sampling: { scrollHz: 9 },
      export: { encryption: "required", privacyScanner: "warn" }
    });
    expect(next.redaction.blockedSelectors).toEqual([".pii"]);
    expect(next.redaction.redactHeaders).toEqual(["authorization", "x-token"]);
    expect(next.pointer.mousemoveHz).toBeUndefined();
    expect(applyProfileFormValues(base, { ...FORM, visual: "" }).visual).toBeUndefined();
  });

  it("builds rules with only the conditions that were filled in", () => {
    expect(
      ruleFromFormValues({
        id: "rule-1",
        name: "",
        profileId: BUILT_IN_PROFILE_IDS.qa,
        priority: "5000",
        enabled: true,
        hosts: "*.stage.test\nlocalhost:*",
        paths: "",
        query: "env=qa",
        titleRegex: "",
        selectorPresent: "",
        metaName: "environment",
        metaValue: "",
        incognito: "never"
      })
    ).toEqual({
      id: "rule-1",
      profileId: BUILT_IN_PROFILE_IDS.qa,
      priority: 1000,
      enabled: true,
      match: {
        hosts: ["*.stage.test", "localhost:*"],
        query: { env: "qa" },
        metaTag: { name: "environment" },
        incognito: false
      }
    });
  });

  it("creates unique ids and deletes profiles with their rules", () => {
    expect(createUniqueId("rule", ["rule-2", "rule-3"])).toBe("rule-4");

    const store: RecordingProfilesStore = {
      schemaVersion: PROFILES_SCHEMA_VERSION,
      defaultProfileId: "custom",
      profiles: [createDefaultProfile(), { ...createDefaultProfile(), id: "custom" }],
      rules: [{ id: "r", profileId: "custom", priority: 0, enabled: true, match: {} }],
      extendedCaptureHosts: []
    };
    const next = deleteProfileFromStore(store, "custom");

    expect(next.defaultProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(next.profiles.map((profile) => profile.id)).toEqual([DEFAULT_PROFILE_ID]);
    expect(next.rules).toEqual([]);
    expect(deleteProfileFromStore(store, DEFAULT_PROFILE_ID)).toBe(store);
  });
});
