import { describe, expect, it } from "vitest";

import { requiresFullEngine, resolveStartEngine, selectionRequiresFullEngine } from "./engine.js";
import {
  BUILT_IN_PROFILE_IDS,
  createBaseProfile,
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile
} from "./presets.js";

function preset(id: string) {
  const profile = findBuiltInProfile(id);

  if (!profile) {
    throw new Error(`missing preset ${id}`);
  }

  return profile;
}

describe("requiresFullEngine", () => {
  it("holds for the QA and Full capture presets only", () => {
    expect(requiresFullEngine(preset(BUILT_IN_PROFILE_IDS.qa))).toBe(true);
    expect(requiresFullEngine(preset(BUILT_IN_PROFILE_IDS.fullCapture))).toBe(true);
    expect(requiresFullEngine(preset(BUILT_IN_PROFILE_IDS.full))).toBe(false);
    expect(requiresFullEngine(preset(BUILT_IN_PROFILE_IDS.lite))).toBe(false);
    expect(requiresFullEngine(createDefaultProfile())).toBe(false);
  });

  it("follows what a duplicated preset captures, not its id", () => {
    const copy = duplicateProfile(preset(BUILT_IN_PROFILE_IDS.fullCapture), { id: "user-copy" });

    expect(requiresFullEngine(copy)).toBe(true);
    expect(
      requiresFullEngine({
        ...copy,
        categories: {
          ...createDefaultProfile().categories,
          inputs: "allow",
          storage: "allow"
        },
        visual: undefined
      })
    ).toBe(false);
  });

  it.each([
    ["request bodies", { network: "body-allowlist" }],
    ["screenshots", { screenshots: "masked" }],
    ["tab video", { screenRecordings: "allow" }],
    ["the whole console", { console: "allow" }],
    ["CDP", { cdp: "safe-subset" }]
  ] as const)("holds for a profile that asks for %s", (_label, categories) => {
    const base = createDefaultProfile();

    expect(
      requiresFullEngine(
        createBaseProfile({ id: "p", name: "P", categories: { ...base.categories, ...categories } })
      )
    ).toBe(true);
  });

  it("holds for a pinned visual capture, but not for a pinned none", () => {
    expect(requiresFullEngine(createBaseProfile({ id: "p", name: "P", visual: "recording" }))).toBe(
      true
    );
    expect(requiresFullEngine(createBaseProfile({ id: "p", name: "P", visual: "none" }))).toBe(
      false
    );
  });
});

describe("resolveStartEngine", () => {
  const fullCapture = preset(BUILT_IN_PROFILE_IDS.fullCapture);

  it("upgrades a Lite start for a profile that needs Full", () => {
    expect(resolveStartEngine("lite", { profile: fullCapture, legacy: false })).toBe("full");
    expect(resolveStartEngine("full", { profile: fullCapture, legacy: false })).toBe("full");
  });

  it("keeps the requested engine for a profile that works in both", () => {
    const profile = createDefaultProfile();

    expect(resolveStartEngine("lite", { profile, legacy: false })).toBe("lite");
    expect(resolveStartEngine("full", { profile, legacy: false })).toBe("full");
  });

  it("leaves the legacy Default switchable whatever its v1 options ask for", () => {
    const legacyDefault = { ...createDefaultProfile(), categories: fullCapture.categories };

    expect(selectionRequiresFullEngine({ profile: legacyDefault, legacy: true })).toBe(false);
    expect(resolveStartEngine("lite", { profile: legacyDefault, legacy: true })).toBe("lite");
  });
});
