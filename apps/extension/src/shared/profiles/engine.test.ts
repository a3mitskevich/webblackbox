import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { requiresFullEngine, resolveStartEngine } from "./engine.js";
import {
  BUILT_IN_PROFILE_IDS,
  createBaseProfile,
  createDefaultProfile,
  duplicateProfile,
  findBuiltInProfile
} from "./presets.js";
import { migrateLegacyOptionsToProfiles } from "./storage.js";

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
    expect(resolveStartEngine("lite", fullCapture)).toBe("full");
    expect(resolveStartEngine("full", fullCapture)).toBe("full");
  });

  it("keeps the requested engine for a profile that works in both", () => {
    const profile = createDefaultProfile();

    expect(resolveStartEngine("lite", profile)).toBe("lite");
    expect(resolveStartEngine("full", profile)).toBe("full");
  });

  it("keeps a Default migrated from options page v1 options switchable", () => {
    const [migrated] = migrateLegacyOptionsToProfiles({
      ...DEFAULT_RECORDER_CONFIG,
      optionsVersion: 1,
      sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, mousemoveHz: 30 }
    }).profiles;

    expect(resolveStartEngine("lite", migrated!)).toBe("lite");
    expect(resolveStartEngine("full", migrated!)).toBe("full");
  });

  it("starts a Default whose categories need Full in Full, like any other profile", () => {
    const raised = { ...createDefaultProfile(), categories: fullCapture.categories };

    expect(resolveStartEngine("lite", raised)).toBe("full");
  });
});
