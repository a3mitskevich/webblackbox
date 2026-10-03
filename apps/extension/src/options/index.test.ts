// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "webblackbox.options";
const PROFILES_KEY = "webblackbox.profiles";
const ARCHIVE_KEY = "webblackbox.popup.export-policy";

function installChromeStub(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const get = vi.fn(async (keys?: string | string[]) => {
    const wanted = keys === undefined ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, data[key]]));
  });
  const set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(data, structuredClone(values));
  });

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: { getManifest: () => ({ version: "9.9.9" }) },
      storage: { local: { get, set } }
    }
  });

  return { data, set };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function importOptionsModule(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
  await flush();
}

function query<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);

  if (!element) {
    throw new Error(`missing ${selector}`);
  }

  return element;
}

function typeNumber(id: string, value: string): HTMLInputElement {
  const input = query<HTMLInputElement>(`#${id}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

function typeText(selector: string, value: string): HTMLInputElement {
  const input = query<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
}

const STORE_WITH_RULE = {
  schemaVersion: 2,
  defaultProfileId: "default",
  profiles: [],
  rules: [
    { id: "stage", name: "Stage", profileId: "default", priority: 10, enabled: true, match: {} }
  ],
  extendedCaptureHosts: []
};

const saveButton = () => query<HTMLButtonElement>("[data-action='settings-save']");
const cancelButton = () => query<HTMLButtonElement>("[data-action='settings-cancel']");
const saveState = () => query<HTMLElement>("[data-save-state]").textContent;

describe("options page", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="options-root"></main>`;
    localStorage.clear();
    location.hash = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("lays out every section with navigation and shows one at a time", async () => {
    installChromeStub();
    await importOptionsModule();

    const sections = [...document.querySelectorAll<HTMLElement>("[data-options-section]")];
    const visible = sections.filter((section) => !section.hidden);

    expect(sections.map((section) => section.dataset.optionsSection)).toEqual([
      "profiles",
      "rules",
      "sensitivity",
      "pointer",
      "sampling",
      "budgets",
      "export",
      "language",
      "transfer"
    ]);
    expect(visible.map((section) => section.dataset.optionsSection)).toEqual(["profiles"]);
    expect(query("[data-section-link='profiles']").getAttribute("aria-current")).toBe("page");

    location.hash = "#sampling";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(query<HTMLElement>("[data-options-section='sampling']").hidden).toBe(false);
    expect(query<HTMLElement>("[data-options-section='profiles']").hidden).toBe(true);
  });

  it("renders stored list values as plain text chips instead of DOM", async () => {
    const injectedValue = `</textarea><button id="pwned">x</button>`;
    installChromeStub({
      [STORAGE_KEY]: {
        redaction: {
          blockedSelectors: [injectedValue],
          redactHeaders: [injectedValue],
          redactBodyPatterns: [injectedValue]
        }
      }
    });

    await importOptionsModule();

    const section = query("[data-general-section='sensitivity']");

    expect(section.querySelectorAll(".wb-chip__text")[0]?.textContent).toBe(injectedValue);
    expect(query<HTMLInputElement>("[data-general-section] [name='redactHeaders']").value).toBe(
      injectedValue
    );
    expect(document.getElementById("pwned")).toBeNull();
  });

  it("renders without inline style attributes", async () => {
    installChromeStub();
    await importOptionsModule();

    expect(document.querySelector("[style]")).toBeNull();
  });

  it("tracks unsaved changes and saves general options and archive limits", async () => {
    const storage = installChromeStub();
    await importOptionsModule();

    expect(saveState()).toBe("All changes saved");
    expect(saveButton().disabled).toBe(true);

    typeNumber("ringBufferMinutes", "15");
    typeNumber("archiveMaxSizeMb", "256");

    expect(saveState()).toBe("Unsaved changes");
    expect(saveButton().disabled).toBe(false);

    saveButton().click();
    await flush();

    expect(storage.data[STORAGE_KEY]).toEqual(
      expect.objectContaining({ ringBufferMinutes: 15, optionsVersion: 1 })
    );
    expect(JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? "null")).toEqual(
      expect.objectContaining({ maxArchiveMb: 256 })
    );
    // No profiles store exists yet, and a general save must not create one.
    expect(storage.data[PROFILES_KEY]).toBeUndefined();
    expect(saveState()).toMatch(/^Saved at /);
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps stored settings the page does not show when saving", async () => {
    const sitePolicies = [{ origin: "https://example.com", allowBodyCapture: true }];
    const storage = installChromeStub({ [STORAGE_KEY]: { sitePolicies } });
    await importOptionsModule();

    typeNumber("scrollHz", "30");
    saveButton().click();
    await flush();

    expect(storage.data[STORAGE_KEY]).toEqual(expect.objectContaining({ sitePolicies }));
  });

  it("blocks saving while a field is invalid and explains why inline", async () => {
    installChromeStub();
    await importOptionsModule();

    const input = typeNumber("mousemoveHz", "999");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.closest(".wb-field")?.textContent).toContain("Use 1–240.");
    expect(saveButton().disabled).toBe(true);
    expect(saveState()).toBe("Fix 1 field(s) before saving.");

    typeNumber("mousemoveHz", "60");

    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(saveButton().disabled).toBe(false);
  });

  it("accepts 0 for the screenshot idle interval and rejects small positive values", async () => {
    installChromeStub();
    await importOptionsModule();

    expect(typeNumber("screenshotIdleMs", "100").getAttribute("aria-invalid")).toBe("true");
    expect(typeNumber("screenshotIdleMs", "0").hasAttribute("aria-invalid")).toBe(false);
  });

  it("lets Discard clear an invalid value that never reached the draft", async () => {
    installChromeStub();
    await importOptionsModule();

    const input = typeNumber("mousemoveHz", "abc");

    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(false);

    cancelButton().click();

    expect(query<HTMLInputElement>("#mousemoveHz").value).not.toBe("abc");
    expect(query<HTMLInputElement>("#mousemoveHz").hasAttribute("aria-invalid")).toBe(false);
    expect(input.isConnected).toBe(false);
    expect(saveState()).toBe("All changes saved");
  });

  it("shows unsaved changes again after a save when a site rule is edited", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    typeNumber("scrollHz", "30");
    saveButton().click();
    await flush();

    expect(saveState()).toMatch(/^Saved at /);

    typeText("[data-rule-id='stage'] [name='ruleName']", "Stage QA");

    expect(saveState()).toBe("Unsaved changes");
    expect(saveButton().disabled).toBe(false);
  });

  it("blocks Save while a chip input holds a rejected entry", async () => {
    installChromeStub();
    await importOptionsModule();

    const chip = typeText("#blockedSelectors-input", "div[");
    chip.dispatchEvent(new Event("blur"));

    expect(chip.getAttribute("aria-invalid")).toBe("true");
    expect(saveState()).toBe("Fix 1 field(s) before saving.");

    typeText("#blockedSelectors-input", "");

    expect(saveState()).toBe("All changes saved");
  });

  it("drops a rejected chip entry's error when its section is reset", async () => {
    installChromeStub();
    await importOptionsModule();

    typeText("#blockedSelectors-input", "div[").dispatchEvent(new Event("blur"));

    expect(saveState()).toBe("Fix 1 field(s) before saving.");

    const section =
      query<HTMLElement>("#blockedSelectors-input").closest<HTMLElement>("[data-general-section]")
        ?.dataset.generalSection;
    query<HTMLElement>(`[data-action='section-reset'][data-section='${section}']`).click();

    expect(saveState()).toBe("All changes saved");
  });

  it("blocks Save while a rule priority is out of range", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    typeText("[data-rule-id='stage'] [name='rulePriority']", "99999999");

    expect(saveButton().disabled).toBe(true);
    expect(saveState()).toBe("Fix 1 field(s) before saving.");

    // Another editor action re-renders the rules; the typed value and its error stay.
    query<HTMLElement>("[data-action='rule-add']").click();
    const priority = query<HTMLInputElement>("[data-rule-id='stage'] [name='rulePriority']");

    expect(priority.value).toBe("99999999");
    expect(priority.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton().disabled).toBe(true);

    typeText("[data-rule-id='stage'] [name='rulePriority']", "20");

    expect(saveButton().disabled).toBe(false);
  });

  it("keeps a typed profile number only in its own open form", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    query<HTMLElement>("[data-profile-id='default'] [data-action='profile-edit']").click();
    typeText("#pf-mousemoveHz", "999");
    query<HTMLElement>("[data-action='rule-add']").click();

    expect(query<HTMLInputElement>("#pf-mousemoveHz").value).toBe("999");
    expect(saveButton().disabled).toBe(true);

    // Cancel on the form discards the typed value together with its error.
    query<HTMLElement>("[data-action='profile-cancel']").click();

    expect(document.querySelector("#pf-mousemoveHz")).toBeNull();
    expect(saveState()).toBe("Unsaved changes");
    expect(saveButton().disabled).toBe(false);

    query<HTMLElement>("[data-profile-id='default'] [data-action='profile-edit']").click();

    expect(query<HTMLInputElement>("#pf-mousemoveHz").value).not.toBe("999");
    expect(query<HTMLInputElement>("#pf-mousemoveHz").hasAttribute("aria-invalid")).toBe(false);
  });

  it("does not leave a profile form that holds an out-of-range number", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    query<HTMLElement>("[data-profile-id='default'] [data-action='profile-edit']").click();
    typeText("#pf-mousemoveHz", "999");

    for (const action of ["profile-duplicate", "profile-apply"]) {
      query<HTMLElement>(`[data-action='${action}']`).click();

      expect(query<HTMLElement>("[data-profile-form]").dataset.profileForm).toBe("default");
      expect(document.activeElement).toBe(query("#pf-mousemoveHz"));
    }

    typeText("#pf-mousemoveHz", "60");
    query<HTMLElement>("[data-action='profile-duplicate']").click();

    // The new profile's form starts from its own values, never from the typed one.
    expect(query<HTMLElement>("[data-profile-form]").dataset.profileForm).not.toBe("default");
    expect(query<HTMLInputElement>("#pf-mousemoveHz").hasAttribute("aria-invalid")).toBe(false);
    expect(saveButton().disabled).toBe(false);
  });

  it("validates a rule's title pattern and selector inline", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    const regex = typeText("[data-rule-id='stage'] [name='ruleTitleRegex']", "(a)\\1");
    const selector = typeText("[data-rule-id='stage'] [name='ruleSelector']", "div[");

    expect(regex.getAttribute("aria-invalid")).toBe("true");
    expect(selector.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton().disabled).toBe(true);

    typeText("[data-rule-id='stage'] [name='ruleTitleRegex']", "Checkout");
    typeText("[data-rule-id='stage'] [name='ruleSelector']", "#app");

    expect(saveButton().disabled).toBe(false);
  });

  it("writes nothing when the profiles draft cannot be saved", async () => {
    const storage = installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    typeNumber("ringBufferMinutes", "15");
    typeNumber("archiveMaxSizeMb", "256");
    typeText("[data-rule-id='stage'] [name='ruleName']", "x".repeat(81));
    saveButton().click();
    await flush();

    expect(saveState()).toMatch(/Save failed/);
    expect(storage.set).not.toHaveBeenCalled();
    expect(localStorage.getItem(ARCHIVE_KEY)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("resets one section to defaults and discards edits with Cancel", async () => {
    installChromeStub({ [STORAGE_KEY]: { ringBufferMinutes: 30 } });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#ringBufferMinutes").value).toBe("30");

    typeNumber("budgetLcpWarnMs", "4000");
    query<HTMLElement>("[data-action='section-reset'][data-section='sampling']").click();

    expect(query<HTMLInputElement>("#ringBufferMinutes").value).toBe("10");
    expect(query<HTMLInputElement>("#budgetLcpWarnMs").value).toBe("4000");

    query<HTMLButtonElement>("[data-action='settings-cancel']").click();

    expect(query<HTMLInputElement>("#ringBufferMinutes").value).toBe("30");
    expect(query<HTMLInputElement>("#budgetLcpWarnMs").value).toBe("2500");
    expect(saveState()).toBe("All changes saved");
  });
});
