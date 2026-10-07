// @vitest-environment jsdom
/* eslint-disable max-lines -- TODO: split by subject; table-driven test file that predates the 800-line guard */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LEGACY_OPTIONS_KEY = "webblackbox.options";
const SETTINGS_VERSION_KEY = "webblackbox.settingsVersion";
const PROFILES_KEY = "webblackbox.profiles";
const BUDGET_KEY = "webblackbox.performanceBudget";
const ARCHIVE_KEY = "webblackbox.popup.export-policy";
const INJECTION_KEY = "webblackbox.injection";
const START_RELOAD_OFFER_KEY = "webblackbox.startReloadOffer";
const PLAYER_URL_KEY = "webblackbox.playerUrl";

/** Settings as the service worker leaves them after its start (v1 options already migrated). */
function installChromeStub(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { [SETTINGS_VERSION_KEY]: 1, ...initial };
  const get = vi.fn(async (keys?: string | string[]) => {
    const wanted = keys === undefined ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, data[key]]));
  });
  const set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(data, structuredClone(values));
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      Reflect.deleteProperty(data, key);
    }
  });

  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      runtime: { getManifest: () => ({ version: "9.9.9" }) },
      storage: { local: { get, set, remove } }
    }
  });

  return { data, set };
}

type StoredProfile = {
  id: string;
  sampling: Record<string, number>;
  redaction: Record<string, unknown>;
  recorder: Record<string, unknown>;
  sitePolicies: unknown[];
  categories: Record<string, string>;
};

/** A profiles store whose Default profile carries `patch` (the rest is today's defaults). */
function storeWithDefault(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    defaultProfileId: "default",
    profiles: [
      {
        id: "default",
        name: "Default",
        base: "lite",
        categories: {
          actions: "metadata",
          inputs: "length-only",
          dom: "masked",
          screenshots: "off",
          screenRecordings: "off",
          console: "metadata",
          network: "metadata",
          storage: "counts-only",
          indexedDb: "counts-only",
          cookies: "count-only",
          cdp: "off",
          heapProfiles: "off",
          tabsContext: "metadata"
        },
        redaction: {
          redactHeaders: ["authorization"],
          redactCookieNames: ["session"],
          redactBodyPatterns: ["password"],
          blockedSelectors: [".secret"],
          hashSensitiveValues: true
        },
        unmaskSelectors: [],
        network: { bodyMimeAllowlist: [], includeUrls: [], excludeUrls: [] },
        pointer: { hover: false, drag: false, wheel: false },
        sampling: {},
        recorder: {},
        sitePolicies: [],
        ...patch
      }
    ],
    rules: [],
    extendedCaptureHosts: []
  };
}

function storedDefaultProfile(data: Record<string, unknown>): StoredProfile | undefined {
  return (data[PROFILES_KEY] as { profiles?: StoredProfile[] } | undefined)?.profiles?.find(
    (profile) => profile.id === "default"
  );
}

/** Keeps the profiles editor loading (it reads the managed policy) until the returned call. */
function holdProfilesEditor(): () => void {
  let release = (): void => undefined;
  const pending = new Promise<Record<string, unknown>>((resolve) => {
    release = () => resolve({});
  });
  const { storage } = (globalThis as unknown as { chrome: { storage: Record<string, unknown> } })
    .chrome;
  storage.managed = { get: () => pending };
  return release;
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
      [PROFILES_KEY]: storeWithDefault({
        redaction: {
          redactHeaders: [injectedValue],
          redactCookieNames: [],
          redactBodyPatterns: [injectedValue],
          blockedSelectors: [injectedValue],
          hashSensitiveValues: true
        }
      })
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

    typeNumber("domFlushMs", "150");
    typeNumber("archiveMaxSizeMb", "256");

    expect(saveState()).toBe("Unsaved changes");
    expect(saveButton().disabled).toBe(false);

    saveButton().click();
    await flush();

    // The recorder fields live in the Default profile: the first save creates the store.
    expect(storedDefaultProfile(storage.data)?.sampling).toEqual({ domFlushMs: 150 });
    expect(JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? "null")).toEqual(
      expect.objectContaining({ maxArchiveMb: 256 })
    );
    expect(storage.data[LEGACY_OPTIONS_KEY]).toBeUndefined();
    expect(storage.data[BUDGET_KEY]).toBeUndefined();
    expect(saveState()).toMatch(/^Saved at /);
    expect(saveButton().disabled).toBe(true);
  });

  it("offers page injection modes with their trade-offs and saves the choice on its own", async () => {
    const storage = installChromeStub();
    await importOptionsModule();

    const group = query("[data-general-section='sampling'] [role='radiogroup']");
    const always = query<HTMLInputElement>("#contentInjection-always");
    const onStart = query<HTMLInputElement>("#contentInjection-on-start");

    expect(group.textContent).toContain("Inject into pages");
    expect(always.checked).toBe(true);
    expect(onStart.checked).toBe(false);
    expect(onStart.closest("label")?.textContent).toContain(
      "Password fields the page revealed before Start are not known as passwords"
    );

    onStart.checked = true;
    onStart.dispatchEvent(new Event("change", { bubbles: true }));

    expect(saveState()).toBe("Unsaved changes");

    saveButton().click();
    await flush();

    expect(storage.data[INJECTION_KEY]).toBe("on-start");
    // The recording profiles are not touched by this setting.
    expect(storage.data[PROFILES_KEY]).toBeUndefined();
    expect(saveState()).toMatch(/^Saved at /);
  });

  it("shows the stored injection mode and resets it with the section", async () => {
    installChromeStub({ [INJECTION_KEY]: "on-start" });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#contentInjection-on-start").checked).toBe(true);

    query<HTMLButtonElement>("[data-action='section-reset'][data-section='sampling']").click();

    expect(query<HTMLInputElement>("#contentInjection-always").checked).toBe(true);
    expect(saveState()).toBe("Unsaved changes");
  });

  it("offers the page reload on Start by default and stores the switch under its own key", async () => {
    const storage = installChromeStub();
    await importOptionsModule();
    const toggle = query<HTMLInputElement>(
      "[data-options-section='sampling'] input#startReloadOffer"
    );

    expect(toggle.checked).toBe(true);

    toggle.click();

    expect(saveState()).toBe("Unsaved changes");
    expect(query("[data-section-link='sampling']").getAttribute("data-dirty")).toBe("true");

    saveButton().click();
    await flush();

    expect(storage.data[START_RELOAD_OFFER_KEY]).toBe(false);
    // A popup preference, not a recorder setting: the profiles stay as they are.
    expect(storage.data[PROFILES_KEY]).toBeUndefined();
    expect(query<HTMLInputElement>("#startReloadOffer").checked).toBe(false);
    expect(saveState()).toMatch(/^Saved at /);
  });

  it("writes the reload offer only when it changed", async () => {
    const storage = installChromeStub();
    await importOptionsModule();

    typeNumber("scrollHz", "30");
    saveButton().click();
    await flush();

    expect(storage.data[START_RELOAD_OFFER_KEY]).toBeUndefined();
  });

  it("shows a stored off switch; section reset turns it back on and Discard restores it", async () => {
    installChromeStub({ [START_RELOAD_OFFER_KEY]: false });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#startReloadOffer").checked).toBe(false);

    query<HTMLElement>("[data-action='section-reset'][data-section='sampling']").click();

    expect(query<HTMLInputElement>("#startReloadOffer").checked).toBe(true);
    expect(saveState()).toBe("Unsaved changes");

    cancelButton().click();

    expect(query<HTMLInputElement>("#startReloadOffer").checked).toBe(false);
    expect(saveState()).toBe("All changes saved");
  });

  it("has no Player URL by default; validates it and stores it under its own key", async () => {
    const storage = installChromeStub();
    await importOptionsModule();
    const input = query<HTMLInputElement>("[data-options-section='export'] input#playerUrl");

    expect(input.value).toBe("");
    expect(input.readOnly).toBe(false);

    typeText("#playerUrl", "http://player.example.com/");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(query("#playerUrl-error").textContent).toContain("https://");
    expect(saveButton().disabled).toBe(true);

    typeText("#playerUrl", "  https://player.example.com  ");

    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(query("[data-section-link='export']").getAttribute("data-dirty")).toBe("true");

    saveButton().click();
    await flush();

    expect(storage.data[PLAYER_URL_KEY]).toBe("https://player.example.com/");
    expect(storage.data[PROFILES_KEY]).toBeUndefined();
    expect(query<HTMLInputElement>("#playerUrl").value).toBe("https://player.example.com/");
    expect(saveState()).toMatch(/^Saved at /);
  });

  it("clears a stored Player URL with an empty value and writes it only when changed", async () => {
    const storage = installChromeStub({ [PLAYER_URL_KEY]: "http://localhost:4177/" });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#playerUrl").value).toBe("http://localhost:4177/");

    typeNumber("scrollHz", "30");
    saveButton().click();
    await flush();

    expect(storage.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ [PLAYER_URL_KEY]: expect.anything() })
    );

    typeText("#playerUrl", "   ");
    saveButton().click();
    await flush();

    expect(storage.data[PLAYER_URL_KEY]).toBe("");
  });

  it("shows the organization's Player URL read-only", async () => {
    installChromeStub({ [PLAYER_URL_KEY]: "https://mine.example.com/" });
    const { storage } = (globalThis as unknown as { chrome: { storage: Record<string, unknown> } })
      .chrome;
    storage.managed = {
      get: async () => ({ enterprisePolicy: { playerUrl: "https://player.corp.example/qa/" } })
    };
    await importOptionsModule();
    const input = query<HTMLInputElement>("#playerUrl");

    expect(input.value).toBe("https://player.corp.example/qa/");
    expect(input.readOnly).toBe(true);
    expect(query("#playerUrl-hint").textContent).toBe("Set by your organization's policy.");
    expect(saveState()).toBe("All changes saved");
  });

  it("keeps the Default profile's settings the page does not show when saving", async () => {
    const sitePolicies = [
      {
        originPattern: "https://*.example.test",
        mode: "full",
        enabled: true,
        allowBodyCapture: true,
        bodyMimeAllowlist: ["application/json"],
        pathAllowlist: [],
        pathDenylist: []
      }
    ];
    const storage = installChromeStub({
      [PROFILES_KEY]: storeWithDefault({ sitePolicies, sampling: { mousemoveHz: 33 } })
    });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#mousemoveHz").value).toBe("33");

    typeNumber("scrollHz", "30");
    saveButton().click();
    await flush();

    expect(storedDefaultProfile(storage.data)).toEqual(
      expect.objectContaining({ sitePolicies, sampling: { mousemoveHz: 33, scrollHz: 30 } })
    );
  });

  it("keeps a corrupt profiles store aside when a General save replaces it", async () => {
    const corrupt = { schemaVersion: 2, profiles: "garbage", rules: 42 };
    const storage = installChromeStub({ [PROFILES_KEY]: corrupt });
    await importOptionsModule();

    typeNumber("scrollHz", "30");
    saveButton().click();
    await flush();

    expect(storedDefaultProfile(storage.data)?.sampling).toEqual({ scrollHz: 30 });
    expect(storage.data["webblackbox.profiles.rejected"]).toEqual(corrupt);
  });

  it("saves the performance budget under its own key, apart from the profiles", async () => {
    const storage = installChromeStub({ [BUDGET_KEY]: { lcpWarnMs: 3000 } });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#budgetLcpWarnMs").value).toBe("3000");

    typeNumber("budgetLcpWarnMs", "4000");
    saveButton().click();
    await flush();

    expect(storage.data[BUDGET_KEY]).toEqual(expect.objectContaining({ lcpWarnMs: 4000 }));
    expect(storage.data[PROFILES_KEY]).toBeUndefined();
  });

  it("migrates v1 options left by an older version before showing the form", async () => {
    const storage = installChromeStub({
      [SETTINGS_VERSION_KEY]: undefined,
      [LEGACY_OPTIONS_KEY]: {
        optionsVersion: 1,
        freezeOnError: false,
        sampling: { domFlushMs: 300 },
        performanceBudget: { requestWarnMs: 900 }
      }
    });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#domFlushMs").value).toBe("300");
    expect(query<HTMLInputElement>("#budgetRequestWarnMs").value).toBe("900");
    expect(storage.data[LEGACY_OPTIONS_KEY]).toBeUndefined();
    expect(storage.data[SETTINGS_VERSION_KEY]).toBe(1);
    expect(storedDefaultProfile(storage.data)).toEqual(
      expect.objectContaining({ sampling: { domFlushMs: 300 }, recorder: { freezeOnError: false } })
    );
    expect(saveState()).toBe("All changes saved");
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

  it("leaves general field errors alone when a profile or rule action re-renders", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    const scroll = typeNumber("scrollHz", "9999");
    const message = scroll.closest(".wb-field")?.textContent;
    query<HTMLElement>("[data-action='rule-add']").click();

    expect(scroll.closest(".wb-field")?.textContent).toBe(message);
    expect(saveState()).toBe("Fix 1 field(s) before saving.");

    typeNumber("scrollHz", "30");

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
    await flush();
    query<HTMLElement>("[data-confirm-accept]").click();
    await flush();

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
    await flush();
    // The form now has edits: leaving it asks first.
    query<HTMLElement>("[role='dialog'] [data-action='editor-close-discard']").click();
    await flush();

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

    typeNumber("domFlushMs", "150");
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
    installChromeStub({ [PROFILES_KEY]: storeWithDefault({ sampling: { domFlushMs: 300 } }) });
    await importOptionsModule();

    expect(query<HTMLInputElement>("#domFlushMs").value).toBe("300");

    typeNumber("budgetLcpWarnMs", "4000");
    query<HTMLElement>("[data-action='section-reset'][data-section='sampling']").click();

    expect(query<HTMLInputElement>("#domFlushMs").value).toBe("100");
    expect(query<HTMLInputElement>("#budgetLcpWarnMs").value).toBe("4000");

    query<HTMLButtonElement>("[data-action='settings-cancel']").click();

    expect(query<HTMLInputElement>("#domFlushMs").value).toBe("300");
    expect(query<HTMLInputElement>("#budgetLcpWarnMs").value).toBe("2500");
    expect(saveState()).toBe("All changes saved");
  });

  describe("language", () => {
    const LOCALE_KEY = "webblackbox.uiLocale";
    const languageSelect = () => query<HTMLSelectElement>("#ui-language");
    const chooseLanguage = async (value: string): Promise<void> => {
      languageSelect().value = value;
      languageSelect().dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    };
    const languageNotice = () =>
      query<HTMLElement>("[data-options-section='language'] [role='status']");

    it("offers Auto and every locale, preselecting the stored choice", async () => {
      installChromeStub({ [LOCALE_KEY]: "zh-CN" });
      await importOptionsModule();

      expect(languageSelect().disabled).toBe(false);
      expect(languageSelect().value).toBe("zh-CN");
      expect([...languageSelect().options].map((option) => option.value)).toEqual([
        "auto",
        "en",
        "ru",
        "zh-CN"
      ]);
    });

    it("renders the page in the stored language", async () => {
      installChromeStub({ [LOCALE_KEY]: "ru" });
      await importOptionsModule();

      expect(document.documentElement.lang).toBe("ru");
      expect(document.title).toBe("Настройки WebBlackbox");
      expect(query("[data-section-link='language']").textContent).toContain("Язык");
      expect(saveState()).toBe("Все изменения сохранены");
    });

    it("treats an unknown stored value as Auto", async () => {
      installChromeStub({ [LOCALE_KEY]: "fr" });
      await importOptionsModule();

      expect(languageSelect().value).toBe("auto");
      expect(document.documentElement.lang).toBe("en");
    });

    it("stores the choice at once without touching the Save bar", async () => {
      const storage = installChromeStub();
      await importOptionsModule();

      await chooseLanguage("en");

      expect(storage.data[LOCALE_KEY]).toBe("en");
      expect(storage.data[PROFILES_KEY]).toBeUndefined();
      expect(saveState()).toBe("All changes saved");
      expect(languageNotice().hidden).toBe(true);
    });

    it("keeps unsaved edits and explains when the new language appears", async () => {
      const storage = installChromeStub();
      await importOptionsModule();

      typeNumber("domFlushMs", "150");
      await chooseLanguage("ru");

      expect(storage.data[LOCALE_KEY]).toBe("ru");
      expect(query<HTMLInputElement>("#domFlushMs").value).toBe("150");
      expect(saveState()).toBe("Unsaved changes");
      expect(languageNotice().hidden).toBe(false);
      expect(languageNotice().textContent).toMatch(/reopen this page/);
    });

    it("reports a failed save", async () => {
      const storage = installChromeStub();
      await importOptionsModule();
      storage.set.mockRejectedValueOnce(new Error("quota"));

      await chooseLanguage("ru");

      expect(languageNotice().hidden).toBe(false);
      expect(languageNotice().textContent).toBe("Could not save the language: quota");
    });
  });
});

describe("options page: unsaved changes", () => {
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

  const navLink = (section: string) => query<HTMLAnchorElement>(`[data-section-link='${section}']`);
  const navDirty = (section: string) => navLink(section).dataset.dirty === "true";
  const headerDirty = (section: string) =>
    query<HTMLElement>(`[data-options-section='${section}'] [data-section-unsaved]`).hidden ===
    false;
  const shownSection = () =>
    document.querySelector<HTMLElement>("[data-options-section]:not([hidden])")?.dataset
      .optionsSection;
  const dialog = () => document.querySelector<HTMLElement>("[role='dialog']");
  const choose = async (action: string): Promise<void> => {
    query<HTMLElement>(`[role='dialog'] [data-action='${action}']`).click();
    await flush();
  };
  const goTo = async (section: string): Promise<void> => {
    navLink(section).click();
    await flush();
  };
  const unloadPrevented = (): boolean => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("marks the changed sections in the navigation, their headers and the save bar", async () => {
    installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    expect(navDirty("pointer")).toBe(false);
    expect(headerDirty("pointer")).toBe(false);
    expect(query("[data-save-detail]").textContent).toBe("");

    typeNumber("scrollHz", "30");
    typeText("[data-rule-id='stage'] [name='ruleName']", "Stage QA");

    expect(navDirty("pointer")).toBe(true);
    expect(navDirty("rules")).toBe(true);
    expect(navDirty("sampling")).toBe(false);
    expect(headerDirty("pointer")).toBe(true);
    expect(headerDirty("rules")).toBe(true);
    expect(headerDirty("sampling")).toBe(false);
    expect(navLink("pointer").textContent).toContain("unsaved changes");
    expect(query("[data-save-detail]").textContent).toBe("In: Site rules, Pointer & input");
    expect(query<HTMLElement>(".wb-savebar").dataset.dirty).toBe("true");

    saveButton().click();
    await flush();

    expect(navDirty("pointer")).toBe(false);
    expect(navDirty("rules")).toBe(false);
    expect(headerDirty("rules")).toBe(false);
    expect(query("[data-save-detail]").textContent).toBe("");
  });

  it("marks a section that holds an invalid value", async () => {
    installChromeStub();
    await importOptionsModule();

    typeNumber("mousemoveHz", "999");

    expect(navDirty("pointer")).toBe(true);
  });

  it("switches sections without asking while nothing is unsaved", async () => {
    installChromeStub();
    await importOptionsModule();

    await goTo("sampling");

    expect(dialog()).toBeNull();
    expect(shownSection()).toBe("sampling");
  });

  it("asks before leaving a section with unsaved changes; Stay keeps them", async () => {
    installChromeStub();
    await importOptionsModule();

    await goTo("pointer");
    typeNumber("scrollHz", "30");
    await goTo("sampling");

    expect(dialog()?.textContent).toContain("Pointer & input");
    expect(shownSection()).toBe("pointer");

    await choose("leave-stay");

    expect(dialog()).toBeNull();
    expect(shownSection()).toBe("pointer");
    expect(query<HTMLInputElement>("#scrollHz").value).toBe("30");
    expect(saveState()).toBe("Unsaved changes");
  });

  it("discards the changes and switches section from the leave prompt", async () => {
    installChromeStub();
    await importOptionsModule();

    await goTo("pointer");
    typeNumber("scrollHz", "30");
    await goTo("sampling");
    await choose("leave-discard");

    expect(shownSection()).toBe("sampling");
    expect(query<HTMLInputElement>("#scrollHz").value).not.toBe("30");
    expect(saveState()).toBe("All changes saved");
  });

  it("saves and then switches section from the leave prompt", async () => {
    const storage = installChromeStub();
    await importOptionsModule();

    await goTo("pointer");
    typeNumber("scrollHz", "30");
    await goTo("sampling");
    await choose("leave-save");

    expect(storedDefaultProfile(storage.data)?.sampling).toEqual({ scrollHz: 30 });
    expect(shownSection()).toBe("sampling");
    expect(saveState()).toMatch(/^Saved at /);
  });

  it("offers no Save in the leave prompt while a field is invalid", async () => {
    installChromeStub();
    await importOptionsModule();

    await goTo("pointer");
    typeNumber("mousemoveHz", "999");
    await goTo("sampling");

    expect(dialog()).not.toBeNull();
    expect(document.querySelector("[data-action='leave-save']")).toBeNull();

    await choose("leave-stay");
  });

  it("asks back/forward navigation to a section too", async () => {
    installChromeStub();
    await importOptionsModule();

    await goTo("pointer");
    typeNumber("scrollHz", "30");
    location.hash = "#budgets";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();

    expect(dialog()).not.toBeNull();
    expect(shownSection()).toBe("pointer");
    expect(location.hash).toBe("#pointer");

    await choose("leave-discard");

    expect(shownSection()).toBe("budgets");
  });

  it("asks before the tab closes only while there are unsaved changes", async () => {
    installChromeStub();
    await importOptionsModule();

    expect(unloadPrevented()).toBe(false);

    typeNumber("scrollHz", "30");

    expect(unloadPrevented()).toBe(true);

    saveButton().click();
    await flush();

    expect(unloadPrevented()).toBe(false);
  });

  it("tracks edits typed before the profiles editor has loaded", async () => {
    const storage = installChromeStub();
    const releaseEditor = holdProfilesEditor();
    await importOptionsModule();

    expect(query("[data-options-section='profiles'] .wb-section__body").childElementCount).toBe(0);

    await goTo("pointer");
    typeNumber("scrollHz", "30");

    expect(saveState()).toBe("Unsaved changes");
    expect(navDirty("pointer")).toBe(true);
    expect(unloadPrevented()).toBe(true);

    await goTo("sampling");
    await choose("leave-save");

    // The save waits for the editor: the general options are folded into its Default profile.
    expect(storage.data[PROFILES_KEY]).toBeUndefined();
    expect(shownSection()).toBe("pointer");

    releaseEditor();
    await flush();

    expect(storedDefaultProfile(storage.data)?.sampling).toEqual({ scrollHz: 30 });
    expect(shownSection()).toBe("sampling");
    expect(saveState()).toMatch(/^Saved at /);
    expect(unloadPrevented()).toBe(false);
  });

  it("saves the whole page from a rule's close prompt", async () => {
    const storage = installChromeStub({ [PROFILES_KEY]: STORE_WITH_RULE });
    await importOptionsModule();

    query<HTMLElement>("[data-rule-id='stage'] [data-action='rule-toggle']").click();
    typeText("[data-rule-id='stage'] [name='ruleName']", "Stage QA");
    typeNumber("scrollHz", "30");
    query<HTMLElement>("[data-rule-id='stage'] [data-action='rule-toggle']").click();
    await flush();
    await choose("editor-close-save");

    expect(storedDefaultProfile(storage.data)?.sampling).toEqual({ scrollHz: 30 });
    expect((storage.data[PROFILES_KEY] as { rules: Array<{ name?: string }> }).rules[0]?.name).toBe(
      "Stage QA"
    );
    expect(saveState()).toMatch(/^Saved at /);
  });
});
