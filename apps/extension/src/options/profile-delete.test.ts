// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChromeApi } from "../shared/chrome-api.js";
import { translateExtensionMessage, type ExtensionMessageKey } from "../shared/i18n.js";
import { PROFILES_STORAGE_KEY, type ProfileRule } from "../shared/profiles/model.js";
import {
  BUILT_IN_PROFILE_IDS,
  createDefaultProfile,
  duplicateProfile
} from "../shared/profiles/presets.js";
import { mountProfilesEditor } from "./profiles-editor.js";

/** Backlog item 4: deleting any profile (at least one stays), restoring the recommended ones. */

const t = (key: ExtensionMessageKey, vars?: Record<string, string | number>): string =>
  translateExtensionMessage("en", key, vars);

const RECOMMENDED_IDS = [
  "default",
  BUILT_IN_PROFILE_IDS.lite,
  BUILT_IN_PROFILE_IDS.full,
  BUILT_IN_PROFILE_IDS.qa,
  BUILT_IN_PROFILE_IDS.fullCapture
];

const rule = (id: string, profileId: string, name?: string): ProfileRule => ({
  id,
  ...(name ? { name } : {}),
  profileId,
  priority: 1,
  enabled: true,
  match: { hosts: [`${id}.example.test`] }
});

function createStorage(store: Record<string, unknown> = {}, managed?: Record<string, unknown>) {
  const data: Record<string, unknown> = {
    [PROFILES_STORAGE_KEY]: {
      schemaVersion: 2,
      defaultProfileId: "default",
      profiles: [],
      rules: [],
      extendedCaptureHosts: [],
      ...store
    }
  };
  const chromeApi = {
    storage: {
      ...(managed ? { managed: { get: vi.fn(async () => structuredClone(managed)) } } : {}),
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

async function mount(storage: ReturnType<typeof createStorage>) {
  const container = document.createElement("div");
  document.body.append(container);
  const handle = await mountProfilesEditor(container, {
    chromeApi: storage.chromeApi,
    t,
    locale: "en",
    legacyOptionsKey: "webblackbox.options",
    enterprisePolicyKey: "enterprisePolicy"
  });
  return { container, handle };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function deleteButton(root: ParentNode, profileId: string): HTMLButtonElement {
  const element = root.querySelector<HTMLButtonElement>(
    `[data-profile-id="${profileId}"] [data-action='profile-delete']`
  );

  if (!element) {
    throw new Error(`missing Delete of ${profileId}`);
  }

  return element;
}

async function deleteProfile(root: ParentNode, profileId: string): Promise<void> {
  deleteButton(root, profileId).click();
  await flush();
  document.querySelector<HTMLElement>("[data-confirm-accept]")?.click();
  await flush();
}

const profileIds = (root: ParentNode): string[] =>
  [...root.querySelectorAll<HTMLElement>("[data-profile-id]")].map(
    (row) => row.dataset.profileId ?? ""
  );

const dialog = (): HTMLElement | null => document.querySelector("[role='dialog']");

const dialogTexts = (selector: string): string[] =>
  [...(dialog()?.querySelectorAll(selector) ?? [])].map((node) => node.textContent ?? "");

function restoreButton(root: ParentNode): HTMLButtonElement {
  const element = root.querySelector<HTMLButtonElement>(
    ".wb-profiles__list-actions [data-action='profiles-restore']"
  );

  if (!element) {
    throw new Error("missing Restore recommended profiles");
  }

  return element;
}

describe("profile deletion and restore", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks before every delete and names the rules that use the profile", async () => {
    const { container } = await mount(
      createStorage({
        rules: [
          rule("stage", "default", "Stage"),
          rule("shop", "default"),
          rule("lite", BUILT_IN_PROFILE_IDS.lite, "Lite site")
        ]
      })
    );

    deleteButton(container, "default").click();
    await flush();

    expect(dialog()?.querySelector(".wb-confirm-title")?.textContent).toBe(
      t("optionsProfileDeleteTitle", { name: "Default" })
    );
    expect(dialog()?.querySelector(".wb-confirm-body")?.textContent).toBe(
      t("optionsProfileDeleteRules", { count: 2 })
    );
    // Rules are named (an unnamed rule by its id), not just counted.
    expect(dialogTexts("[data-confirm-item]")).toEqual(["Stage", "shop"]);
    expect(dialogTexts("[data-confirm-note]")).toEqual([
      t("optionsProfileDeleteRestorable"),
      t("optionsProfileDeleteNewDefault", { name: "Lite" })
    ]);

    document.querySelector<HTMLElement>("[data-confirm-cancel]")?.click();
    await flush();

    expect(profileIds(container)).toContain("default");

    // No rule uses Full: it still asks, and says so.
    deleteButton(container, BUILT_IN_PROFILE_IDS.full).click();
    await flush();

    expect(dialog()?.querySelector(".wb-confirm-body")?.textContent).toBe(
      t("optionsProfileDeleteNoRules")
    );
    expect(dialogTexts("[data-confirm-item]")).toEqual([]);

    document.querySelector<HTMLElement>("[data-confirm-accept]")?.click();
    await flush();

    expect(profileIds(container)).not.toContain(BUILT_IN_PROFILE_IDS.full);
  });

  it("warns that an own profile cannot be restored once saved", async () => {
    const mine = duplicateProfile(createDefaultProfile(), { id: "mine", name: "Mine" });
    const { container } = await mount(createStorage({ profiles: [mine] }));

    deleteButton(container, "mine").click();
    await flush();

    expect(dialogTexts("[data-confirm-note]")).toEqual([t("optionsProfileDeleteOwn")]);
  });

  it("keeps the last profile: Delete is disabled and says why", async () => {
    const { container } = await mount(
      createStorage({
        defaultProfileId: BUILT_IN_PROFILE_IDS.fullCapture,
        removedRecommendedProfileIds: RECOMMENDED_IDS.filter(
          (id) => id !== BUILT_IN_PROFILE_IDS.fullCapture
        )
      })
    );
    const lastDelete = deleteButton(container, BUILT_IN_PROFILE_IDS.fullCapture);
    const hintId = lastDelete.getAttribute("aria-describedby") ?? "";

    expect(lastDelete.disabled).toBe(true);
    expect(document.getElementById(hintId)?.textContent).toBe(t("optionsProfileDeleteLast"));

    // Even a click that gets through (a stale render) leaves the profile in place.
    lastDelete.disabled = false;
    lastDelete.click();
    await flush();

    expect(dialog()).toBeNull();
    expect(profileIds(container)).toEqual([BUILT_IN_PROFILE_IDS.fullCapture]);
  });

  it("deletes down to one profile and then disables the last Delete", async () => {
    const { container, handle } = await mount(createStorage());

    for (const id of RECOMMENDED_IDS.slice(0, -1)) {
      await deleteProfile(container, id);
    }

    expect(profileIds(container)).toEqual([BUILT_IN_PROFILE_IDS.fullCapture]);
    expect(deleteButton(container, BUILT_IN_PROFILE_IDS.fullCapture).disabled).toBe(true);
    expect(container.querySelector("[data-profiles-last]")?.textContent).toBe(
      t("optionsProfileDeleteLast")
    );
    expect(handle.changedSections()).toEqual({ profiles: true, rules: false });
  });

  it("counts policy profiles: the last own profile can go while a policy profile stays", async () => {
    const { container } = await mount(
      createStorage(
        {
          defaultProfileId: BUILT_IN_PROFILE_IDS.lite,
          removedRecommendedProfileIds: RECOMMENDED_IDS.filter(
            (id) => id !== BUILT_IN_PROFILE_IDS.lite
          )
        },
        {
          enterprisePolicy: {
            profiles: [{ id: "corp", name: "Corp", categories: { console: "allow" } }]
          }
        }
      )
    );

    expect(deleteButton(container, BUILT_IN_PROFILE_IDS.lite).disabled).toBe(false);
    expect(container.querySelector("[data-profiles-last]")).toBeNull();
  });

  it("enables Restore only when a recommended profile is missing", async () => {
    const { container } = await mount(createStorage());

    expect(restoreButton(container).disabled).toBe(true);
    expect(container.querySelector("[data-profiles-restore-hint]")?.textContent).toBe(
      t("optionsProfilesRestoreNothing")
    );

    await deleteProfile(container, BUILT_IN_PROFILE_IDS.qa);

    expect(restoreButton(container).disabled).toBe(false);
    expect(container.querySelector("[data-profiles-restore-hint]")?.textContent).toBe(
      t("optionsProfilesRestoreHint")
    );

    restoreButton(container).click();
    await flush();

    expect(profileIds(container)).toEqual(RECOMMENDED_IDS);
    expect(restoreButton(container).disabled).toBe(true);
  });

  it("marks Profiles unsaved when a preset that is not the default is deleted, and clean after Restore", async () => {
    const { container, handle } = await mount(createStorage());

    await deleteProfile(container, BUILT_IN_PROFILE_IDS.qa);

    expect(handle.changedSections()).toEqual({ profiles: true, rules: false });

    restoreButton(container).click();
    await flush();

    expect(handle.changedSections()).toEqual({ profiles: false, rules: false });
  });

  it("keeps another profile's open form and its typed edits when a profile is deleted", async () => {
    const mine = duplicateProfile(createDefaultProfile(), { id: "mine", name: "Mine" });
    const { container } = await mount(createStorage({ profiles: [mine] }));

    container
      .querySelector<HTMLElement>("[data-profile-id='mine'] [data-action='profile-edit']")
      ?.click();
    await flush();
    const name = container.querySelector<HTMLInputElement>("#pf-name");

    if (!name) {
      throw new Error("missing profile form");
    }

    name.value = "Mine edited";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await deleteProfile(container, BUILT_IN_PROFILE_IDS.full);

    expect(container.querySelector("[data-profile-form='mine']")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#pf-name")?.value).toBe("Mine edited");

    // Deleting the profile being edited closes its form.
    await deleteProfile(container, "mine");

    expect(container.querySelector("[data-profile-form]")).toBeNull();
  });

  it("offers Restore in the empty state when no profile is left", async () => {
    const { container } = await mount(
      createStorage({ removedRecommendedProfileIds: RECOMMENDED_IDS })
    );
    const empty = container.querySelector<HTMLElement>("[data-profiles-empty]");

    expect(profileIds(container)).toEqual([]);
    expect(empty?.textContent).toContain(t("optionsProfilesEmpty"));

    empty?.querySelector<HTMLElement>("[data-action='profiles-restore']")?.click();
    await flush();

    expect(profileIds(container)).toEqual(RECOMMENDED_IDS);
    expect(container.querySelector("[data-profiles-empty]")).toBeNull();
  });
});
