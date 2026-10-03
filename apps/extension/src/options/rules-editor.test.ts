// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { translateExtensionMessage, type ExtensionMessageKey } from "../shared/i18n.js";
import { PROFILES_STORAGE_KEY, type ProfileRule } from "../shared/profiles/model.js";
import { BUILT_IN_PROFILE_IDS } from "../shared/profiles/presets.js";
import { reorderRules, sortRulesForDisplay } from "./profile-form-model.js";
import { mountProfilesEditor } from "./profiles-editor.js";

const t = (key: ExtensionMessageKey, vars?: Record<string, string | number>): string =>
  translateExtensionMessage("en", key, vars);

const rule = (id: string, priority: number, hosts: string[] = []): ProfileRule => ({
  id,
  name: id.toUpperCase(),
  profileId: "default",
  priority,
  enabled: true,
  match: hosts.length > 0 ? { hosts } : {}
});

function storageWith(rules: ProfileRule[]) {
  const data: Record<string, unknown> = {
    [PROFILES_STORAGE_KEY]: {
      schemaVersion: 2,
      defaultProfileId: "default",
      profiles: [],
      rules,
      extendedCaptureHosts: []
    }
  };
  const chromeApi = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) =>
          Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]))
        ),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(data, structuredClone(values));
        })
      }
    }
  } as unknown as ChromeApi;
  return { data, chromeApi };
}

async function mount(rules: ProfileRule[]) {
  const storage = storageWith(rules);
  const container = document.createElement("div");
  const onChange = vi.fn();
  document.body.append(container);
  const handle = await mountProfilesEditor(container, {
    chromeApi: storage.chromeApi,
    t,
    locale: "en",
    legacyOptionsKey: "webblackbox.options",
    enterprisePolicyKey: "enterprisePolicy",
    onChange
  });
  return { container, handle, storage, onChange };
}

const ruleIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>("[data-rule-id]")].map(
    (row) => row.dataset.ruleId ?? ""
  );

function typeInto(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector);

  if (!input) {
    throw new Error(`missing ${selector}`);
  }

  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("rule ordering model", () => {
  it("shows rules by priority and keeps list order for ties", () => {
    expect(
      sortRulesForDisplay([rule("a", 0), rule("b", 5), rule("c", 0)]).map((entry) => entry.id)
    ).toEqual(["b", "a", "c"]);
  });

  it("renumbers priorities top to bottom after a move", () => {
    const moved = reorderRules([rule("a", 30), rule("b", 20), rule("c", 10)], 2, 0);

    expect(moved.map((entry) => [entry.id, entry.priority])).toEqual([
      ["c", 30],
      ["a", 20],
      ["b", 10]
    ]);
    expect(reorderRules([rule("a", 1)], 0, 3).map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("rules editor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves a rule up and saves the new priorities", async () => {
    const { container, handle, storage } = await mount([rule("a", 20), rule("b", 10)]);

    expect(ruleIds(container)).toEqual(["a", "b"]);
    expect(
      container.querySelector<HTMLButtonElement>("[data-rule-id='a'] [data-action='rule-up']")
        ?.disabled
    ).toBe(true);

    container.querySelector<HTMLElement>("[data-rule-id='b'] [data-action='rule-up']")?.click();

    expect(ruleIds(container)).toEqual(["b", "a"]);
    expect(handle.isDirty()).toBe(true);

    await handle.save();
    const saved = storage.data[PROFILES_STORAGE_KEY] as { rules: ProfileRule[] };

    expect(saved.rules.map((entry) => [entry.id, entry.priority])).toEqual([
      ["b", 20],
      ["a", 10]
    ]);
    expect(handle.isDirty()).toBe(false);
  });

  it("collapses rules and toggles their body", async () => {
    const { container } = await mount([rule("a", 0, ["*.stage.test"])]);
    const toggle = container.querySelector<HTMLElement>("[data-action='rule-toggle']");
    const body = container.querySelector<HTMLElement>(".wb-rule__body");

    expect(body?.hidden).toBe(true);
    toggle?.click();
    expect(body?.hidden).toBe(false);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("explains which profile a URL gets and why", async () => {
    const qaRule = { ...rule("stage", 10, ["*.stage.test"]), profileId: BUILT_IN_PROFILE_IDS.qa };
    const { container } = await mount([qaRule]);
    const result = () => container.querySelector("[data-rule-test-result]")?.textContent ?? "";

    typeInto(container, "[name='testUrl']", "https://app.stage.test/cart");

    expect(result()).toContain("QA");
    expect(result()).toContain("STAGE");
    expect(result()).toContain("*.stage.test");

    typeInto(container, "[name='testUrl']", "https://example.org/");

    expect(result()).toContain("No rule matches");

    typeInto(container, "[name='testUrl']", "not a url");

    expect(result()).toBe("Enter a full http(s) URL.");
  });

  it("uses unsaved rule edits when testing a URL", async () => {
    const { container } = await mount([rule("a", 0, ["old.test"])]);
    const hosts = container.querySelector<HTMLInputElement>("[name='ruleHosts']");

    if (hosts) {
      hosts.value = "new.test";
    }

    typeInto(container, "[name='testUrl']", "https://new.test/");

    expect(container.querySelector("[data-rule-test-result]")?.textContent).toContain("new.test");
  });

  it("rejects invalid selectors in chip lists and tracks unsaved changes", async () => {
    const { container, onChange, handle } = await mount([]);
    container.querySelector<HTMLElement>("[data-action='profile-edit']")?.click();
    const input = container.querySelector<HTMLInputElement>("#pf-blockedSelectors");

    if (!input) {
      throw new Error("missing selector chip input");
    }

    input.value = "div[";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.closest(".wb-field")?.textContent).toContain("Not a valid CSS selector.");

    onChange.mockClear();
    input.value = ".card-number";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onChange).toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(
      container.querySelector<HTMLInputElement>(".wb-profiles__form [name='blockedSelectors']")
        ?.value
    ).toContain(".card-number");
    expect(handle.isDirty()).toBe(true);

    handle.cancel();

    expect(handle.isDirty()).toBe(false);
  });
});
