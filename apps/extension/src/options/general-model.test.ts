import { describe, expect, it } from "vitest";

import {
  createDefaultGeneralDraft,
  findField,
  isInjectionChanged,
  isStoredOptionsChanged,
  resetGeneralSection,
  toStoredOptionsPayload,
  type ChoiceFieldSpec
} from "./general-model.js";

function injectionField(): ChoiceFieldSpec {
  const spec = findField("contentInjection");

  if (spec?.kind !== "choice") {
    throw new Error("contentInjection is not a choice field");
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
