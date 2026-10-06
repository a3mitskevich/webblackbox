import { describe, expect, it } from "vitest";

import {
  changedGeneralSections,
  createDefaultGeneralDraft,
  findField,
  isPlayerUrlChanged,
  resetGeneralSection,
  type TextFieldSpec
} from "./general-model.js";

function playerUrlField(): TextFieldSpec {
  const spec = findField("playerUrl");

  if (spec?.kind !== "text") {
    throw new Error("playerUrl is not a text field");
  }

  return spec;
}

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
