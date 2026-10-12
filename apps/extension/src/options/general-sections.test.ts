// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { translateExtensionMessage, type ExtensionMessageKey } from "../shared/i18n.js";
import { createDefaultGeneralDraft } from "./general-model.js";
import { renderGeneralSection } from "./general-sections.js";

const t = (key: ExtensionMessageKey, vars?: Record<string, string | number>): string =>
  translateExtensionMessage("en", key, vars);

function render(section: "sensitivity" | "budgets", hasDefaultProfile: boolean): HTMLElement {
  return renderGeneralSection(section, { ...createDefaultGeneralDraft(), hasDefaultProfile }, t);
}

describe("renderGeneralSection", () => {
  it("says the profile fields edit the kept Default (custom), not the profile recording by default", () => {
    const section = render("sensitivity", true);
    const notice = section.querySelector("[data-kept-default-notice]");

    expect(notice?.textContent).toContain("Default (custom)");
    expect(notice?.querySelector("a")?.getAttribute("href")).toBe("#profiles");
    expect(section.querySelector("[data-profile-fields-notice]")).toBeNull();
    expect(section.querySelector("input, textarea")).not.toBeNull();
  });

  it("points to the profiles instead of the fields when no Default profile is kept", () => {
    const section = render("sensitivity", false);

    expect(section.querySelector("[data-profile-fields-notice]")).not.toBeNull();
    expect(section.querySelector("[data-kept-default-notice]")).toBeNull();
  });

  it("adds no notice to a section without profile fields", () => {
    const section = render("budgets", true);

    expect(section.querySelector("[data-kept-default-notice]")).toBeNull();
    expect(section.querySelector("[data-profile-fields-notice]")).toBeNull();
  });
});
