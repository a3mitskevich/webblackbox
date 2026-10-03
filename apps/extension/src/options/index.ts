import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";

import { getChromeApi } from "../shared/chrome-api.js";
import { loadExportPolicyPrefs, saveExportPolicyPrefs } from "../shared/export-policy-prefs.js";
import { createExtensionI18n } from "../shared/i18n.js";
import {
  ENTERPRISE_POLICY_STORAGE_KEY,
  migrateStoredRecorderConfig
} from "../shared/options-storage.js";
import { normalizePerformanceBudget } from "../shared/performance-budget.js";
import { PROFILES_STORAGE_KEY } from "../shared/profiles/model.js";
import {
  applyDefaultProfileToGeneralForm,
  parseProfilesStore,
  serializeProfilesStore,
  syncDefaultProfileWithLegacyOptions
} from "../shared/profiles/storage.js";
import { el } from "../shared/ui/dom.js";
import {
  fieldGroup,
  installTooltipDismiss,
  PENDING_ERROR_EVENT,
  selectField,
  type PendingErrorDetail
} from "./fields.js";
import {
  createDefaultGeneralDraft,
  isArchiveChanged,
  isStoredOptionsChanged,
  normalizeOptionsConfig,
  resetGeneralSection,
  toStoredOptionsPayload,
  type GeneralDraft,
  type GeneralSectionId
} from "./general-model.js";
import { applyGeneralFieldInput, renderGeneralSection } from "./general-sections.js";
import { createSettingsShell, sectionFromHash, type SettingsShell } from "./layout.js";
import { mountProfilesEditor, type ProfilesEditorHandle } from "./profiles-editor.js";

const STORAGE_KEY = "webblackbox.options";
const GENERAL_SECTIONS: readonly GeneralSectionId[] = [
  "sensitivity",
  "pointer",
  "sampling",
  "budgets",
  "export"
];

const chromeApi = getChromeApi();
const i18n = createExtensionI18n({ pageTitleKey: "pageTitleOptions" });
const { locale, t } = i18n;
const extensionVersion = chromeApi?.runtime?.getManifest?.().version ?? "dev";
const root = document.getElementById("options-root");

type PageState = {
  shell: SettingsShell;
  baseline: GeneralDraft;
  draft: GeneralDraft;
  /** Field id → inline error; Save is blocked while any remain. */
  errors: Map<string, string>;
  /**
   * Control behind each pending-text error. Renders replace controls (same ids, empty values),
   * so an error whose control left the DOM is dropped.
   */
  pendingSources: Map<string, Element>;
  generalHosts: Record<GeneralSectionId, HTMLElement>;
  editor?: ProfilesEditorHandle;
  status?: { text: string; error: boolean };
  saving: boolean;
};

if (root) {
  bootstrap(root).catch((error) => {
    renderError(root, error);
  });
}

async function bootstrap(container: HTMLElement): Promise<void> {
  const shell = createSettingsShell(t, extensionVersion);
  const loaded = await loadGeneralDraft();
  const generalHosts = Object.fromEntries(
    GENERAL_SECTIONS.map((section) => [section, el("div")])
  ) as unknown as Record<GeneralSectionId, HTMLElement>;
  const page: PageState = {
    shell,
    baseline: loaded,
    draft: loaded,
    errors: new Map(),
    pendingSources: new Map(),
    generalHosts,
    saving: false
  };
  const sandboxSlot = el("div", { className: "wb-section__extra" });

  for (const section of GENERAL_SECTIONS) {
    shell.bodies[section].append(generalHosts[section]);
  }

  shell.bodies.sensitivity.append(sandboxSlot);
  shell.bodies.export.append(el("p", { className: "wb-notice", text: t("optionsEncryptionNote") }));
  shell.bodies.language.append(createLanguagePanel());
  renderGeneral(page);
  container.replaceChildren(shell.root);
  shell.showSection(sectionFromHash(location.hash));
  window.addEventListener("hashchange", () => shell.showSection(sectionFromHash(location.hash)));

  page.editor = await mountProfilesEditor(
    shell.content,
    {
      chromeApi,
      t,
      locale,
      legacyOptionsKey: STORAGE_KEY,
      enterprisePolicyKey: ENTERPRISE_POLICY_STORAGE_KEY,
      onChange: () => refreshSaveBar(page)
    },
    {
      profiles: shell.bodies.profiles,
      rules: shell.bodies.rules,
      sandbox: sandboxSlot,
      transfer: shell.bodies.transfer
    }
  );

  bindPage(page);
  refreshSaveBar(page);
}

function bindPage(page: PageState): void {
  const { shell } = page;
  const onFieldEvent = (event: Event): void => {
    const update = applyGeneralFieldInput(event.target, page.draft, t);

    if (!update) {
      return;
    }

    page.draft = update.draft;

    if (update.error) {
      page.errors.set(update.fieldId, update.error);
    } else {
      page.errors.delete(update.fieldId);
    }

    page.status = undefined;
    refreshSaveBar(page);
  };

  shell.content.addEventListener("input", onFieldEvent);
  shell.content.addEventListener("change", onFieldEvent);
  // Invalid text left in a chip input blocks Save instead of being dropped by it.
  shell.content.addEventListener(PENDING_ERROR_EVENT, (event) => {
    const { key, error } = (event as CustomEvent<PendingErrorDetail>).detail;

    if (error && event.target instanceof Element) {
      page.errors.set(key, error);
      page.pendingSources.set(key, event.target);
    } else {
      page.errors.delete(key);
      page.pendingSources.delete(key);
    }

    refreshSaveBar(page);
  });
  installTooltipDismiss(shell.root);
  shell.content.addEventListener("click", (event) => {
    const reset = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-action='section-reset']"
    );
    const section = GENERAL_SECTIONS.find((entry) => entry === reset?.dataset.section);

    if (section) {
      page.draft = resetGeneralSection(page.draft, section);
      clearSectionErrors(page, section);
      renderGeneral(page, section);
      page.status = undefined;
      refreshSaveBar(page);
    }
  });
  shell.saveButton.addEventListener("click", () => {
    void saveAll(page);
  });
  shell.cancelButton.addEventListener("click", () => cancelAll(page));
  window.addEventListener("beforeunload", (event) => {
    if (isDirty(page)) {
      event.preventDefault();
    }
  });
}

function clearSectionErrors(page: PageState, section: GeneralSectionId): void {
  page.generalHosts[section]
    .querySelectorAll<HTMLInputElement>("input[name]")
    .forEach((input) => page.errors.delete(input.name));
}

/**
 * Pending-text errors whose control a render replaced (section reset, another profile form,
 * deleted rule). A control that is still invalid after a render reports itself again.
 */
function dropDetachedPendingErrors(page: PageState): void {
  for (const [key, source] of [...page.pendingSources]) {
    if (!source.isConnected) {
      page.errors.delete(key);
      page.pendingSources.delete(key);
    }
  }
}

function renderGeneral(page: PageState, only?: GeneralSectionId): void {
  for (const section of only ? [only] : GENERAL_SECTIONS) {
    page.generalHosts[section].replaceChildren(renderGeneralSection(section, page.draft, t));
  }
}

function isDirty(page: PageState): boolean {
  return (
    isStoredOptionsChanged(page.draft, page.baseline) ||
    isArchiveChanged(page.draft, page.baseline) ||
    (page.editor?.isDirty() ?? false)
  );
}

function refreshSaveBar(page: PageState): void {
  const { shell } = page;
  dropDetachedPendingErrors(page);
  const dirty = isDirty(page);
  const errorCount = page.errors.size;

  shell.saveButton.closest(".wb-savebar")?.setAttribute("data-dirty", String(dirty));
  shell.saveState.classList.toggle(
    "wb-savebar__state--error",
    Boolean(page.status?.error) || errorCount > 0
  );
  // A failed save stays visible until the next attempt; "Saved at" gives way to new edits.
  shell.saveState.textContent =
    errorCount > 0
      ? t("optionsSaveBlocked", { count: errorCount })
      : page.status?.error
        ? page.status.text
        : dirty
          ? t("optionsUnsavedChanges")
          : (page.status?.text ?? t("optionsAllSaved"));
  shell.saveButton.disabled = page.saving || !dirty || errorCount > 0;
  // Discard also clears invalid typed values that never reached the draft.
  shell.cancelButton.disabled = page.saving || (!dirty && errorCount === 0);
}

/**
 * Saves the general options, the archive preferences and the profiles store. The profiles store
 * is only written when the editor itself changed something; otherwise a general save only syncs
 * an existing store's Default profile, as before (no store is created behind the user's back).
 */
async function saveAll(page: PageState): Promise<void> {
  const editor = page.editor;

  if (!editor || page.errors.size > 0 || page.saving) {
    return;
  }

  const generalChanged = isStoredOptionsChanged(page.draft, page.baseline);
  const archiveChanged = isArchiveChanged(page.draft, page.baseline);
  const profilesChanged = editor.isDirty();
  page.saving = true;
  refreshSaveBar(page);

  try {
    // Nothing is written when the profiles draft cannot be saved, so a failed Save never leaves
    // the general options ahead of the Default profile they are folded into.
    const validation = profilesChanged ? editor.validate() : { ok: true as const };

    if (!validation.ok) {
      throw new Error(validation.error);
    }

    if (generalChanged) {
      const payload = toStoredOptionsPayload(page.draft);
      await chromeApi?.storage?.local.set({ [STORAGE_KEY]: payload });
      page.baseline = { ...page.draft, archive: page.baseline.archive };

      if (profilesChanged) {
        // The editor's draft must not write the old Default values back on its save.
        editor.applyGeneralOptions(payload);
      } else {
        await syncSavedProfilesWithGeneralOptions(payload);
      }
    }

    if (profilesChanged) {
      const result = await editor.save();

      if (!result.ok) {
        throw new Error(result.error);
      }
    } else if (generalChanged) {
      await editor.reload();
    }

    if (archiveChanged && !saveExportPolicyPrefs(page.draft.archive)) {
      throw new Error(t("optionsArchiveSaveFailed"));
    }

    const reloaded = await loadGeneralDraft();
    page.baseline = reloaded;
    page.draft = reloaded;
    renderGeneral(page);
    page.status = {
      text: t("optionsSavedAt", { time: new Date().toLocaleTimeString(locale) }),
      error: false
    };
  } catch (error) {
    page.status = {
      text: t("optionsSaveFailed", {
        error: error instanceof Error ? error.message : String(error)
      }),
      error: true
    };
  } finally {
    page.saving = false;
    refreshSaveBar(page);
  }
}

function cancelAll(page: PageState): void {
  page.draft = page.baseline;
  page.errors.clear();
  page.pendingSources.clear();
  page.status = undefined;
  renderGeneral(page);
  page.editor?.cancel();
  refreshSaveBar(page);
}

/** Once profiles are saved, the general form shows the Default profile's matching fields. */
async function loadGeneralDraft(): Promise<GeneralDraft> {
  const values = await chromeApi?.storage?.local.get([STORAGE_KEY, PROFILES_STORAGE_KEY]);
  const legacy = toLegacyGeneralFields(values?.[STORAGE_KEY]);
  const parsed = parseProfilesStore(values?.[PROFILES_STORAGE_KEY]);

  return {
    ...legacy,
    recorderConfig: parsed
      ? applyDefaultProfileToGeneralForm(legacy.recorderConfig, parsed.store)
      : legacy.recorderConfig,
    archive: loadExportPolicyPrefs()
  };
}

function toLegacyGeneralFields(stored: unknown): Omit<GeneralDraft, "archive"> {
  if (!stored || typeof stored !== "object") {
    const defaults = createDefaultGeneralDraft();
    return {
      recorderConfig: defaults.recorderConfig,
      performanceBudget: defaults.performanceBudget
    };
  }

  const record = migrateStoredRecorderConfig(
    stored as Partial<RecorderConfig> & { optionsVersion?: unknown; performanceBudget?: unknown }
  );

  return {
    recorderConfig: normalizeOptionsConfig({
      ...DEFAULT_RECORDER_CONFIG,
      ...record,
      sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, ...(record.sampling ?? {}) },
      redaction: { ...DEFAULT_RECORDER_CONFIG.redaction, ...(record.redaction ?? {}) }
    }),
    performanceBudget: normalizePerformanceBudget(record.performanceBudget)
  };
}

/** Once profiles are saved, the general form edits the Default profile's matching fields. */
async function syncSavedProfilesWithGeneralOptions(payload: unknown): Promise<void> {
  const values = await chromeApi?.storage?.local.get(PROFILES_STORAGE_KEY);
  const parsed = parseProfilesStore(values?.[PROFILES_STORAGE_KEY]);

  if (!parsed) {
    return;
  }

  await chromeApi?.storage?.local.set({
    [PROFILES_STORAGE_KEY]: serializeProfilesStore(
      syncDefaultProfileWithLegacyOptions(parsed.store, payload)
    )
  });
}

function createLanguagePanel(): HTMLElement {
  return el("div", { className: "wb-section__groups" }, [
    fieldGroup(null, [
      selectField({
        id: "ui-language",
        label: t("optionsLanguageLabel"),
        hint: t("optionsLanguageFollowsBrowser"),
        value: locale,
        disabled: true,
        options: [
          { value: "en", label: "English" },
          { value: "zh-CN", label: "简体中文" }
        ]
      })
    ]),
    el("p", { className: "wb-notice", text: t("optionsLanguageComing") })
  ]);
}

function renderError(container: HTMLElement, error: unknown): void {
  container.replaceChildren(
    el("section", { className: "card wb-options-error" }, [
      el("h1", { className: "wb-options-title", text: t("optionsTitle") }),
      el("p", { className: "wb-notice wb-notice--error", text: String(error) })
    ])
  );
}
