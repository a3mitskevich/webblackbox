// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROFILES_STORAGE_KEY } from "../shared/profiles/model.js";
import { BUILT_IN_PROFILE_IDS } from "../shared/profiles/presets.js";
import { createProfilesExportFile } from "../shared/profiles/transfer.js";
import { translateExtensionMessage, type ExtensionMessageKey } from "../shared/i18n.js";
import type { ChromeApi } from "../shared/chrome-api.js";
import { mountProfilesEditor } from "./profiles-editor.js";

const t = (key: ExtensionMessageKey, vars?: Record<string, string | number>): string =>
  translateExtensionMessage("en", key, vars);

function createStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
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

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function click(root: ParentNode, selector: string): void {
  const element = root.querySelector<HTMLElement>(selector);

  if (!element) {
    throw new Error(`missing ${selector}`);
  }

  element.click();
}

function rowOf(root: ParentNode, profileId: string): HTMLElement {
  const row = root.querySelector<HTMLElement>(`[data-profile-id="${profileId}"]`);

  if (!row) {
    throw new Error(`missing row ${profileId}`);
  }

  return row;
}

function setField(root: ParentNode, name: string, value: string): void {
  const control = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[name="${name}"]`
  );

  if (!control) {
    throw new Error(`missing field ${name}`);
  }

  if (control instanceof HTMLInputElement && control.type === "radio") {
    const radio = root.querySelector<HTMLInputElement>(`[name="${name}"][value="${value}"]`);

    if (!radio) {
      throw new Error(`missing option ${value} of ${name}`);
    }

    radio.checked = true;
    return;
  }

  control.value = value;
}

let lastHandle: Awaited<ReturnType<typeof mountProfilesEditor>> | undefined;

async function saveProfiles(): Promise<void> {
  await lastHandle?.save();
  await flush();
}

async function mount(storage: ReturnType<typeof createStorage>): Promise<HTMLElement> {
  return (await mountWithHandle(storage)).container;
}

async function mountWithHandle(storage: ReturnType<typeof createStorage>) {
  const container = document.createElement("div");
  document.body.append(container);
  const handle = await mountProfilesEditor(container, {
    chromeApi: storage.chromeApi,
    t,
    locale: "en",
    legacyOptionsKey: "webblackbox.options",
    enterprisePolicyKey: "enterprisePolicy"
  });
  lastHandle = handle;
  return { container, handle };
}

function savedStore(storage: ReturnType<typeof createStorage>) {
  return storage.data[PROFILES_STORAGE_KEY] as {
    profiles: Array<{ id: string; name: string; redaction: Record<string, unknown> }>;
    rules: Array<{ id: string; profileId: string }>;
  };
}

describe("profiles editor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists Default and the read-only presets", async () => {
    const container = await mount(createStorage());
    const rows = [...container.querySelectorAll<HTMLElement>("[data-profile-id]")];

    expect(rows.map((row) => row.dataset.profileId)).toEqual([
      "default",
      BUILT_IN_PROFILE_IDS.lite,
      BUILT_IN_PROFILE_IDS.full,
      BUILT_IN_PROFILE_IDS.qa,
      BUILT_IN_PROFILE_IDS.fullCapture
    ]);
    expect(rowOf(container, BUILT_IN_PROFILE_IDS.qa).textContent).toContain("read-only · extended");
    expect(
      rowOf(container, BUILT_IN_PROFILE_IDS.qa).querySelector("[data-action='profile-edit']")
    ).toBeNull();
  });

  it("duplicates a preset, edits it, adds a rule and saves a valid store", async () => {
    const storage = createStorage();
    const container = await mount(storage);

    click(rowOf(container, BUILT_IN_PROFILE_IDS.qa), "[data-action='profile-duplicate']");
    setField(container, "name", "Stage QA");
    setField(container, "category-inputs", "allow");
    click(container, "[data-action='profile-apply']");
    click(container, "[data-action='rule-add']");
    setField(container, "ruleProfile", "profile-2");
    setField(container, "ruleHosts", "*.stage.example.com");
    setField(container, "extendedCaptureHosts", "localhost:*");
    await saveProfiles();

    const saved = storage.data[PROFILES_STORAGE_KEY] as {
      profiles: Array<{ id: string; name: string; categories: Record<string, string> }>;
      rules: Array<{ profileId: string; match: { hosts?: string[] } }>;
      extendedCaptureHosts: string[];
    };

    expect(saved.profiles.map((profile) => [profile.id, profile.name])).toEqual([
      ["default", "Default"],
      ["profile-2", "Stage QA"]
    ]);
    expect(saved.profiles[1]?.categories.inputs).toBe("allow");
    expect(saved.rules).toEqual([
      expect.objectContaining({
        profileId: "profile-2",
        match: { hosts: ["*.stage.example.com"] }
      })
    ]);
    expect(saved.extendedCaptureHosts).toEqual(["localhost:*"]);
    expect(container.querySelector("[data-profiles-status]")?.textContent).toContain(
      "Profiles saved"
    );
  });

  it("shows validation errors instead of saving invalid rules", async () => {
    const storage = createStorage();
    const container = await mount(storage);

    click(container, "[data-action='rule-add']");
    setField(container, "ruleTitleRegex", "(");
    await saveProfiles();

    expect(storage.data[PROFILES_STORAGE_KEY]).toBeUndefined();
    expect(container.querySelector("[data-profiles-status]")?.textContent).toContain("rule #1");
  });

  it("previews an import diff before applying it", async () => {
    const storage = createStorage();
    const container = await mount(storage);
    const file = createProfilesExportFile({
      schemaVersion: 2,
      defaultProfileId: "default",
      profiles: [],
      rules: [
        {
          id: "stage",
          profileId: BUILT_IN_PROFILE_IDS.qa,
          priority: 1,
          enabled: true,
          match: { hosts: ["*.stage.test"] }
        }
      ],
      extendedCaptureHosts: []
    });
    const input = container.querySelector<HTMLInputElement>('input[name="profilesImport"]');

    if (!input) {
      throw new Error("missing import input");
    }

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ text: async () => JSON.stringify(file) }]
    });
    input.dispatchEvent(new Event("change"));
    await flush();

    expect(container.querySelector("[data-import-summary]")?.textContent).toBe(
      "Profiles: +0 −0 ~0. Rules: +1 −0 ~0."
    );

    // A rule added after the preview is replaced too, so the preview now lists it.
    click(container, "[data-action='rule-add']");

    expect(container.querySelector("[data-import-summary]")?.textContent).toBe(
      "Profiles: +0 −0 ~0. Rules: +1 −1 ~0."
    );

    click(container, "[data-action='profiles-import-apply']");

    expect(container.querySelectorAll(".wb-profiles__rule")).toHaveLength(1);
    expect(storage.data[PROFILES_STORAGE_KEY]).toBeUndefined();
  });

  it("saves edits still open in the profile form, and Cancel discards them", async () => {
    const storage = createStorage();
    const container = await mount(storage);

    click(rowOf(container, BUILT_IN_PROFILE_IDS.full), "[data-action='profile-duplicate']");
    setField(container, "name", "Not applied yet");
    await saveProfiles();

    expect(savedStore(storage).profiles.map((profile) => profile.name)).toContain(
      "Not applied yet"
    );

    click(rowOf(container, "default"), "[data-action='profile-edit']");
    setField(container, "name", "Discarded");
    click(container, "[data-action='profile-cancel']");
    await saveProfiles();

    expect(savedStore(storage).profiles.map((profile) => profile.name)).not.toContain("Discarded");
  });

  it("rolls back form edits that another action already kept when Cancel is clicked", async () => {
    const storage = createStorage();
    const container = await mount(storage);

    click(rowOf(container, "default"), "[data-action='profile-edit']");
    setField(container, "category-inputs", "allow");
    click(container, "[data-action='rule-add']");
    click(container, "[data-action='profile-cancel']");
    await saveProfiles();

    const saved = storage.data[PROFILES_STORAGE_KEY] as {
      profiles: Array<{ id: string; categories: Record<string, string> }>;
    };

    expect(saved.profiles.find((profile) => profile.id === "default")?.categories.inputs).toBe(
      "length-only"
    );
  });

  it("keeps a general settings save when the open Default form is cancelled", async () => {
    const storage = createStorage();
    const { container, handle } = await mountWithHandle(storage);

    click(rowOf(container, "default"), "[data-action='profile-edit']");
    handle.applyGeneralOptions({
      optionsVersion: 1,
      redaction: { blockedSelectors: [".from-general-form"] }
    });
    click(container, "[data-action='profile-cancel']");
    await saveProfiles();

    expect(savedStore(storage).profiles[0]?.redaction.blockedSelectors).toEqual([
      ".from-general-form"
    ]);
  });

  it("keeps a rule whose profile no longer exists selectable", async () => {
    const storage = createStorage({
      [PROFILES_STORAGE_KEY]: {
        schemaVersion: 2,
        defaultProfileId: "default",
        profiles: [],
        rules: [{ id: "r1", profileId: "managed:gone", priority: 0, enabled: true, match: {} }],
        extendedCaptureHosts: []
      }
    });
    const container = await mount(storage);
    const select = container.querySelector<HTMLSelectElement>('[name="ruleProfile"]');

    expect(select?.value).toBe("managed:gone");
    expect(select?.selectedOptions[0]?.textContent).toBe("Missing profile: managed:gone");

    await saveProfiles();

    expect(savedStore(storage).rules).toEqual([
      expect.objectContaining({ id: "r1", profileId: "managed:gone" })
    ]);
  });

  it("shows host and default changes in the import preview", async () => {
    const container = await mount(createStorage());
    const file = createProfilesExportFile({
      schemaVersion: 2,
      defaultProfileId: "default",
      profiles: [],
      rules: [],
      extendedCaptureHosts: ["*.corp.test"]
    });
    const input = container.querySelector<HTMLInputElement>('input[name="profilesImport"]');

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{ text: async () => JSON.stringify(file) }]
    });
    input?.dispatchEvent(new Event("change"));
    await flush();

    expect(
      [...container.querySelectorAll("[data-import-detail]")].map((node) => node.textContent)
    ).toEqual(["Hosts allowed for extended profiles: added *.corp.test; removed —"]);
  });

  it("folds a general settings save into the unsaved draft", async () => {
    const storage = createStorage();
    const { container, handle } = await mountWithHandle(storage);

    click(rowOf(container, BUILT_IN_PROFILE_IDS.full), "[data-action='profile-duplicate']");
    click(container, "[data-action='profile-apply']");
    handle.applyGeneralOptions({
      optionsVersion: 1,
      redaction: { blockedSelectors: [".from-general-form"] }
    });
    await saveProfiles();

    const saved = savedStore(storage);

    expect(saved.profiles.map((profile) => profile.id)).toEqual(["default", "profile-2"]);
    expect(saved.profiles[0]?.redaction.blockedSelectors).toEqual([".from-general-form"]);
  });

  it("previews redaction with the selected profile", async () => {
    const container = await mount(createStorage());

    setField(container, "sandboxProfile", BUILT_IN_PROFILE_IDS.qa);
    setField(container, "sandboxKind", "body");
    setField(container, "sandboxInput", '{"password":"hunter2","user":"ann"}');
    click(container, "[data-action='sandbox-run']");

    expect(container.querySelector("[data-sandbox-output]")?.textContent).toBe(
      '{"password":"[REDACTED]","user":"ann"}'
    );
  });
});
