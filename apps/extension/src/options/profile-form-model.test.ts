import { describe, expect, it } from "vitest";

import { BUILT_IN_PROFILE_IDS, createDefaultProfile } from "../shared/profiles/presets.js";
import {
  applyProfileFormValues,
  createUniqueId,
  duplicateIntoStore,
  formatQueryLines,
  formatValuePatternLines,
  parseValuePatternLines,
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
  contentRedaction: true,
  builtInHeuristics: false,
  blockedSelectors: ".pii\n.pii\n",
  unmaskSelectors: ".order-id",
  redactHeaders: "Authorization\nX-Token",
  redactCookieNames: "sid",
  redactBodyPatterns: "password",
  redactQueryParams: "token\ncode",
  redactStorageKeys: "auth",
  valuePatterns: "[bodies, console] sk_live_\\w+\nacct-\\d+",
  bodyMimeAllowlist: "Application/JSON",
  bodyMaxBytes: "65536",
  includeUrls: "",
  excludeUrls: "*/auth/*",
  mousemoveHz: "",
  visual: "screenshots",
  sourceMaps: "embed",
  sourceMapMaxBytes: "1048576"
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
      // Export rules are no longer edited: every archive is encrypted.
      export: base.export
    });
    expect(next.redaction).toMatchObject({
      contentRedaction: true,
      builtInHeuristics: false,
      redactCookieNames: ["sid"],
      redactQueryParams: ["token", "code"],
      redactStorageKeys: ["auth"],
      valuePatterns: [
        { pattern: "sk_live_\\w+", targets: ["bodies", "console"] },
        { pattern: "acct-\\d+", targets: ["bodies", "dom", "storage", "inputs", "console", "urls"] }
      ]
    });
    const bracketed = [
      {
        pattern: "[A-Z]{3}\\d+",
        targets: ["bodies", "dom", "storage", "inputs", "console", "urls"] as const
      }
    ].map((rule) => ({ ...rule, targets: [...rule.targets] }));

    expect(parseValuePatternLines(formatValuePatternLines(bracketed))).toEqual(bracketed);
    expect(formatValuePatternLines(next.redaction.valuePatterns)).toBe(
      "[bodies, console] sk_live_\\w+\nacct-\\d+"
    );
    expect(next.redaction.blockedSelectors).toEqual([".pii"]);
    expect(next.redaction.redactHeaders).toEqual(["authorization", "x-token"]);
    expect(next.pointer.mousemoveHz).toBeUndefined();
    expect(applyProfileFormValues(base, { ...FORM, visual: "" }).visual).toBeUndefined();
  });

  it("sets, clamps and clears the source map option", () => {
    const base = createDefaultProfile();

    expect(applyProfileFormValues(base, FORM).sourceMaps).toEqual({
      mode: "embed",
      maxMapBytes: 1_048_576
    });
    expect(
      applyProfileFormValues(base, { ...FORM, sourceMaps: "metadata", sourceMapMaxBytes: "" })
        .sourceMaps
    ).toEqual({ mode: "metadata" });
    expect(
      applyProfileFormValues(base, { ...FORM, sourceMapMaxBytes: "999999999999" }).sourceMaps
        ?.maxMapBytes
    ).toBe(32 * 1024 * 1024);

    const withMaps = { ...base, sourceMaps: { mode: "off" as const } };

    expect(
      applyProfileFormValues(withMaps, { ...FORM, sourceMaps: "" }).sourceMaps
    ).toBeUndefined();
    expect(
      applyProfileFormValues(withMaps, { ...FORM, sourceMaps: "bogus" }).sourceMaps
    ).toBeUndefined();
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

  it("creates unique ids", () => {
    expect(createUniqueId("rule", ["rule-2", "rule-3"])).toBe("rule-4");
  });

  it("never gives a copy the id a rule or the default still points to", () => {
    // A rule left behind by a deleted profile must not silently start using a new copy.
    const store = {
      schemaVersion: 2 as const,
      defaultProfileId: "profile-3",
      profiles: [createDefaultProfile()],
      rules: [
        {
          id: "bank",
          profileId: "profile-2",
          priority: 1,
          enabled: true,
          match: { hosts: ["*.bank.example"] }
        }
      ],
      extendedCaptureHosts: []
    };
    const { id } = duplicateIntoStore(store, createDefaultProfile());

    expect(id).toBe("profile-4");
  });
});
