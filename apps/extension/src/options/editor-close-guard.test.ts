// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { translateExtensionMessage, type ExtensionMessageKey } from "../shared/i18n.js";
import { PROFILES_STORAGE_KEY, type ProfileRule } from "../shared/profiles/model.js";
import { mountProfilesEditor } from "./profiles-editor.js";

const t = (key: ExtensionMessageKey, vars?: Record<string, string | number>): string =>
  translateExtensionMessage("en", key, vars);

const SAVED_RULE: ProfileRule = {
  id: "stage",
  name: "Stage",
  profileId: "default",
  priority: 10,
  enabled: true,
  match: { hosts: ["*.stage.test"] }
};

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mount(options: { requestSave?: () => Promise<boolean> } = {}) {
  const data: Record<string, unknown> = {
    [PROFILES_STORAGE_KEY]: {
      schemaVersion: 2,
      defaultProfileId: "default",
      profiles: [],
      rules: [SAVED_RULE],
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
  const container = document.createElement("div");
  document.body.append(container);
  const handle = await mountProfilesEditor(container, {
    chromeApi,
    t,
    locale: "en",
    enterprisePolicyKey: "enterprisePolicy",
    ...(options.requestSave ? { requestSave: options.requestSave } : {})
  });

  return { container, handle, data };
}

function find<TElement extends Element = HTMLElement>(
  root: ParentNode,
  selector: string
): TElement {
  const element = root.querySelector<TElement>(selector);

  if (!element) {
    throw new Error(`missing ${selector}`);
  }

  return element;
}

function type(root: ParentNode, selector: string, value: string): void {
  const input = find<HTMLInputElement>(root, selector);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const dialog = () => document.querySelector<HTMLElement>("[role='dialog']");
const choose = async (action: string): Promise<void> => {
  find(document, `[role='dialog'] [data-action='${action}']`).click();
  await flush();
};
const editDefault = (container: HTMLElement) =>
  find(container, "[data-profile-id='default'] [data-action='profile-edit']").click();
const openForm = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-profile-form]")?.dataset.profileForm;
const ruleRow = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-rule-id='${id}']`);
const toggleRule = (container: HTMLElement, id: string) =>
  find(container, `[data-rule-id='${id}'] [data-action='rule-toggle']`).click();
const ruleOpen = (container: HTMLElement, id: string) =>
  ruleRow(container, id)?.querySelector<HTMLElement>(".wb-rule__body")?.hidden === false;
const unsavedBadge = (row: Element | null) =>
  row?.querySelector<HTMLElement>("[data-unsaved-badge]")?.hidden === false;

describe("profiles editor: unsaved edits guard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("closes a profile form without asking when nothing was edited", async () => {
    const { container, handle } = await mount();

    editDefault(container);
    find(container, "[data-action='profile-apply']").click();
    await flush();

    expect(dialog()).toBeNull();
    expect(openForm(container)).toBeUndefined();
    expect(handle.isDirty()).toBe(false);
  });

  it("asks before Apply closes a profile form with edits; Keep editing keeps it open", async () => {
    const { container } = await mount();

    editDefault(container);
    type(container, "#pf-name", "Renamed");
    find(container, "[data-action='profile-apply']").click();
    await flush();

    expect(dialog()?.textContent).toContain("Renamed");

    await choose("editor-close-keep");

    expect(dialog()).toBeNull();
    expect(openForm(container)).toBe("default");
    expect(find<HTMLInputElement>(container, "#pf-name").value).toBe("Renamed");
  });

  it("keeps guarding a form's edits when Edit of the open profile is clicked again", async () => {
    const { container, handle } = await mount();

    editDefault(container);
    type(container, "#pf-name", "Renamed");
    editDefault(container);
    await flush();

    expect(dialog()).toBeNull();
    expect(find<HTMLInputElement>(container, "#pf-name").value).toBe("Renamed");

    find(container, "[data-action='profile-cancel']").click();
    await flush();

    expect(dialog()?.textContent).toContain("Renamed");

    find(document, "[data-confirm-accept]").click();
    await flush();

    expect(openForm(container)).toBeUndefined();
    expect(handle.isDirty()).toBe(false);
  });

  it("discards the form's edits and closes it when Discard is chosen", async () => {
    const { container, handle } = await mount();

    editDefault(container);
    type(container, "#pf-name", "Renamed");
    find(container, "[data-action='profile-apply']").click();
    await flush();
    await choose("editor-close-discard");

    expect(openForm(container)).toBeUndefined();
    expect(find(container, "[data-profile-id='default']").textContent).not.toContain("Renamed");
    expect(handle.isDirty()).toBe(false);
  });

  it("saves through the page and then opens the other profile when Save is chosen", async () => {
    const requestSave = vi.fn(async () => true);
    const { container } = await mount({ requestSave });

    editDefault(container);
    type(container, "#pf-name", "Renamed");
    find(container, "[data-profile-id='builtin:full'] [data-action='profile-duplicate']").click();
    await flush();

    expect(dialog()).not.toBeNull();

    await choose("editor-close-save");

    expect(requestSave).toHaveBeenCalledTimes(1);
    expect(openForm(container)).not.toBe("default");
    expect(openForm(container)).toBeDefined();
  });

  it("stays in the form when the save from the prompt fails", async () => {
    const { container } = await mount({ requestSave: async () => false });

    editDefault(container);
    type(container, "#pf-name", "Renamed");
    find(container, "[data-action='profile-apply']").click();
    await flush();
    await choose("editor-close-save");

    expect(openForm(container)).toBe("default");
  });

  it("asks before Cancel throws away a form's edits", async () => {
    const { container } = await mount();

    editDefault(container);
    type(container, "#pf-name", "Renamed");
    find(container, "[data-action='profile-cancel']").click();
    await flush();

    find(document, "[data-confirm-cancel]").click();
    await flush();

    expect(find<HTMLInputElement>(container, "#pf-name").value).toBe("Renamed");

    find(container, "[data-action='profile-cancel']").click();
    await flush();
    find(document, "[data-confirm-accept]").click();
    await flush();

    expect(openForm(container)).toBeUndefined();
    expect(find(container, "[data-profile-id='default']").textContent).not.toContain("Renamed");
  });

  it("collapses an unchanged saved rule without asking", async () => {
    const { container } = await mount();

    toggleRule(container, "stage");
    expect(ruleOpen(container, "stage")).toBe(true);
    toggleRule(container, "stage");
    await flush();

    expect(dialog()).toBeNull();
    expect(ruleOpen(container, "stage")).toBe(false);
  });

  it("asks before collapsing an edited rule and reverts it on Discard", async () => {
    const { container, handle } = await mount();

    toggleRule(container, "stage");
    type(container, "[data-rule-id='stage'] [name='ruleName']", "Stage edited");

    expect(unsavedBadge(ruleRow(container, "stage"))).toBe(true);

    toggleRule(container, "stage");
    await flush();

    expect(dialog()?.textContent).toContain("Stage edited");

    await choose("editor-close-discard");

    expect(
      find<HTMLInputElement>(container, "[data-rule-id='stage'] [name='ruleName']").value
    ).toBe("Stage");
    expect(ruleOpen(container, "stage")).toBe(false);
    expect(unsavedBadge(ruleRow(container, "stage"))).toBe(false);
    expect(handle.isDirty()).toBe(false);
  });

  it("removes a new rule that is discarded from its close prompt", async () => {
    const { container, handle } = await mount();

    find(container, "[data-action='rule-add']").click();
    const added = [...container.querySelectorAll<HTMLElement>("[data-rule-id]")].find(
      (row) => row.dataset.ruleId !== "stage"
    );
    const addedId = added?.dataset.ruleId ?? "";

    expect(unsavedBadge(added ?? null)).toBe(true);
    expect(handle.changedSections()).toEqual({ profiles: false, rules: true });

    toggleRule(container, addedId);
    await flush();
    await choose("editor-close-discard");

    expect(ruleRow(container, addedId)).toBeNull();
    expect(handle.isDirty()).toBe(false);
  });

  it("keeps a rule open when Keep editing is chosen, and collapses it after a save", async () => {
    const requestSave = vi.fn(async () => true);
    const { container } = await mount({ requestSave });

    toggleRule(container, "stage");
    type(container, "[data-rule-id='stage'] [name='ruleName']", "Stage edited");
    toggleRule(container, "stage");
    await flush();
    await choose("editor-close-keep");

    expect(ruleOpen(container, "stage")).toBe(true);

    toggleRule(container, "stage");
    await flush();
    await choose("editor-close-save");

    expect(requestSave).toHaveBeenCalledTimes(1);
    expect(ruleOpen(container, "stage")).toBe(false);
  });

  it("reports which part of the draft changed", async () => {
    const { container, handle } = await mount();

    expect(handle.changedSections()).toEqual({ profiles: false, rules: false });

    editDefault(container);
    type(container, "#pf-name", "Renamed");

    expect(handle.changedSections()).toEqual({ profiles: true, rules: false });
    expect(unsavedBadge(find(container, "[data-profile-id='default']"))).toBe(true);

    await handle.save();

    expect(handle.changedSections()).toEqual({ profiles: false, rules: false });
    expect(unsavedBadge(find(container, "[data-profile-id='default']"))).toBe(false);
  });
});
