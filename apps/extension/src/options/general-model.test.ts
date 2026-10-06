import { describe, expect, it } from "vitest";

import {
  changedGeneralSections,
  createDefaultGeneralDraft,
  findField,
  isInjectionChanged,
  isPlayerUrlChanged,
  isStoredOptionsChanged,
  resetGeneralSection,
  toStoredOptionsPayload,
  type ChoiceFieldSpec,
  type TextFieldSpec
} from "./general-model.js";

function injectionField(): ChoiceFieldSpec {
  const spec = findField("contentInjection");

  if (spec?.kind !== "choice") {
    throw new Error("contentInjection is not a choice field");
  }

  return spec;
}

function playerUrlField(): TextFieldSpec {
  const spec = findField("playerUrl");

  if (spec?.kind !== "text") {
    throw new Error("playerUrl is not a text field");
  }

  return spec;
}

describe("content injection setting", () => {
  it("defaults to injecting into every page and lives in Performance & sampling", () => {
    const spec = injectionField();

    expect(spec.section).toBe("sampling");
    expect(spec.options.map((option) => option.value)).toEqual(["always", "on-start"]);
    expect(spec.get(createDefaultGeneralDraft())).toBe("always");
  });

  it("accepts the known modes only", () => {
    const spec = injectionField();
    const draft = createDefaultGeneralDraft();

    expect(spec.set(draft, "on-start").injection).toBe("on-start");
    expect(spec.set(draft, "sometimes")).toBe(draft);
  });

  it("is compared on its own and stays out of the stored options record", () => {
    const spec = injectionField();
    const baseline = createDefaultGeneralDraft();
    const draft = spec.set(baseline, "on-start");

    expect(isInjectionChanged(draft, baseline)).toBe(true);
    expect(isStoredOptionsChanged(draft, baseline)).toBe(false);
    expect(toStoredOptionsPayload(draft)).not.toHaveProperty("injection");
  });

  it("goes back to the default with the section reset", () => {
    const draft = injectionField().set(createDefaultGeneralDraft(), "on-start");

    expect(resetGeneralSection(draft, "sampling").injection).toBe("always");
    expect(resetGeneralSection(draft, "pointer").injection).toBe("on-start");
  });
});

describe("general settings model: Player URL", () => {
  it("is empty by default and lives in the export section", () => {
    expect(createDefaultGeneralDraft().playerUrl).toBe("");
    expect(playerUrlField().section).toBe("export");
  });

  it("validates typed input with a localized error key", () => {
    const spec = playerUrlField();

    expect(spec.validate(" https://player.example.com ")).toEqual({
      ok: true,
      value: "https://player.example.com/"
    });
    expect(spec.validate("")).toEqual({ ok: true, value: "" });
    expect(spec.validate("http://player.example.com/")).toEqual({
      ok: false,
      key: "optionsErrorPlayerUrl"
    });
  });

  it("marks the export section changed and resets with it", () => {
    const baseline = createDefaultGeneralDraft();
    const draft = playerUrlField().set(baseline, "https://player.example.com/");

    expect(isPlayerUrlChanged(draft, baseline)).toBe(true);
    expect(changedGeneralSections(draft, baseline)).toEqual(["export"]);
    expect(resetGeneralSection(draft, "export").playerUrl).toBe("");
    expect(resetGeneralSection(draft, "sampling").playerUrl).toBe("https://player.example.com/");
  });
});
