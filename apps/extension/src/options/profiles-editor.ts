import type { ChromeApi } from "../shared/chrome-api.js";
import type { ExtensionMessageKey } from "../shared/i18n.js";
import {
  normalizeEnterprisePolicy,
  readManagedEnterprisePolicy
} from "../shared/options-storage.js";
import { CAPTURE_CATEGORY_KEYS } from "../shared/profiles/categories.js";
import {
  isReadOnlyProfileId,
  PROFILES_STORAGE_KEY,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "../shared/profiles/model.js";
import {
  describeIssues,
  parseManagedProfilesPolicy,
  resolveProfilesState,
  serializeProfilesStore,
  syncDefaultProfileWithLegacyOptions,
  type ProfilesState
} from "../shared/profiles/storage.js";
import {
  createProfilesExportFile,
  previewProfilesImport,
  type ProfilesDiff
} from "../shared/profiles/transfer.js";
import { openConfirmDialog } from "../shared/ui/dialogs.js";
import { preserveFocus } from "../shared/ui/focus.js";
import { el, readCheckbox, readField } from "./dom.js";
import {
  blocksLeavingProfileForm,
  captureInvalidRangeInputs,
  restoreInvalidRangeInputs,
  validateRangeInput,
  validateRuleTextFields,
  validateRuleTextInput
} from "./editor-validation.js";
import { bindRuleDragging, shownRuleIds } from "./rules-drag.js";
import { readSandboxInputs, runRedactionSandbox, type SandboxState } from "./sandbox-model.js";
import { createProfileForm } from "./profile-form.js";
import {
  applyProfileFormValues,
  createUniqueId,
  deleteProfileFromStore,
  duplicateIntoStore,
  reorderRules,
  ruleFromFormValues,
  sortRulesForDisplay,
  stableJson
} from "./profile-form-model.js";
import { createProfileCard, createSandboxPanel, createTransferPanel } from "./profiles-view.js";
import { testRulesForUrl } from "./rule-tester.js";
import { createRuleTester, createRulesList, describeTestResult } from "./rules-editor.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type ProfilesEditorDeps = {
  chromeApi: ChromeApi | null;
  t: Translate;
  locale: string;
  legacyOptionsKey: string;
  enterprisePolicyKey: string;
  /** Called after any change of the draft (typing included) so the page can show dirty state. */
  onChange?: () => void;
};

/** Where each part of the editor renders; the settings page puts them in different sections. */
export type ProfilesEditorSlots = {
  profiles: HTMLElement;
  rules: HTMLElement;
  sandbox: HTMLElement;
  transfer: HTMLElement;
};

export type ProfilesSaveResult = { ok: true } | { ok: false; error: string };

export type ProfilesEditorHandle = {
  /** Folds a general settings save into the draft's Default profile. */
  applyGeneralOptions(payload: unknown): void;
  /** The draft (including open forms and rule rows) differs from what was loaded or saved. */
  isDirty(): boolean;
  /** A v2 profiles store exists in storage (otherwise Default mirrors the general options). */
  hasStoredStore(): boolean;
  /** Checks that the draft can be saved, without writing anything. */
  validate(): ProfilesSaveResult;
  save(): Promise<ProfilesSaveResult>;
  /** Reloads from storage, dropping the draft. */
  reload(): Promise<void>;
  /** Drops the draft and returns to the saved state. */
  cancel(): void;
};

type EditorState = {
  profilesState: ProfilesState;
  draft: RecordingProfilesStore;
  editingId?: string;
  /** The edited profile as it was when its form opened; Cancel restores it. */
  editingSnapshot?: RecordingProfile;
  /** The file replaces the draft; `diff` is kept against the current draft (see `update`). */
  importPreview?: { text: string; next: RecordingProfilesStore; diff: ProfilesDiff };
  status?: { text: string; error: boolean };
  sandbox: SandboxState;
  openRuleIds: Set<string>;
  test: { url: string; title: string; incognito: boolean };
  /** Managed-policy hosts where extended profiles may run (Test URL applies them too). */
  enterpriseSiteAllowlist: readonly string[];
  /** Stable JSON of the draft as last loaded/saved, after one DOM round trip. */
  baseline: string;
};

type Editor = {
  state: EditorState;
  root: HTMLElement;
  slots: ProfilesEditorSlots;
  deps: ProfilesEditorDeps;
};

type Update = (mutate: () => void, options?: { discardFormEdits?: boolean }) => void;

/**
 * Profiles & rules editor. Rendering lives in profile-form / rules-editor / profiles-view; the
 * logic in profile-form-model and shared/profiles. Inputs are read back from the DOM before every
 * action, so typed values are never lost between renders.
 */
export async function mountProfilesEditor(
  root: HTMLElement,
  deps: ProfilesEditorDeps,
  providedSlots?: ProfilesEditorSlots
): Promise<ProfilesEditorHandle> {
  const slots = providedSlots ?? createDefaultSlots(root);
  const profilesState = await loadState(deps);
  const enterpriseSiteAllowlist = await loadEnterpriseSiteAllowlist(deps);
  const editor: Editor = {
    root,
    slots,
    deps,
    state: {
      profilesState,
      draft: structuredClone(profilesState.store),
      sandbox: { profileId: profilesState.store.defaultProfileId, kind: "body", text: "" },
      openRuleIds: new Set(),
      test: { url: "", title: "", incognito: false },
      enterpriseSiteAllowlist,
      baseline: ""
    }
  };

  render(editor);
  resetBaseline(editor);
  bindEditor(editor);

  return {
    applyGeneralOptions: (payload) => {
      syncDraftFromDom(editor);
      const { state } = editor;
      state.draft = syncDefaultProfileWithLegacyOptions(state.draft, payload);
      // The general save is already stored; Cancel must not roll it back.
      const snapshot = state.editingSnapshot;
      state.editingSnapshot = snapshot
        ? syncDefaultProfileWithLegacyOptions({ ...state.draft, profiles: [snapshot] }, payload)
            .profiles[0]
        : undefined;
      render(editor);
    },
    isDirty: () => isDirty(editor),
    hasStoredStore: () => !editor.state.profilesState.legacy,
    validate: () => {
      syncDraftFromDom(editor);

      try {
        serializeProfilesStore(editor.state.draft);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: deps.t("optionsProfilesError", {
            error: error instanceof Error ? error.message : String(error)
          })
        };
      }
    },
    save: async () => {
      syncDraftFromDom(editor);
      await saveDraft(editor);
      const { state } = editor;

      // What was just saved is the new baseline for Cancel.
      if (state.editingId && !state.status?.error) {
        openProfileForm(state, state.editingId);
      }

      render(editor);

      if (state.status?.error) {
        return { ok: false, error: state.status.text };
      }

      resetBaseline(editor);
      return { ok: true };
    },
    reload: async () => {
      editor.state.profilesState = await loadState(deps);
      editor.state.enterpriseSiteAllowlist = await loadEnterpriseSiteAllowlist(deps);
      discardDraft(editor);
    },
    cancel: () => discardDraft(editor)
  };
}

function createDefaultSlots(root: HTMLElement): ProfilesEditorSlots {
  const slots = { profiles: el("div"), rules: el("div"), sandbox: el("div"), transfer: el("div") };
  root.append(slots.profiles, slots.rules, slots.sandbox, slots.transfer);
  return slots;
}

async function loadEnterpriseSiteAllowlist(deps: ProfilesEditorDeps): Promise<string[]> {
  const managedPolicy = await readManagedEnterprisePolicy(
    deps.chromeApi?.storage?.managed,
    deps.enterprisePolicyKey
  );

  return normalizeEnterprisePolicy(managedPolicy).siteAllowlist;
}

async function loadState(deps: ProfilesEditorDeps): Promise<ProfilesState> {
  const local = await deps.chromeApi?.storage?.local
    ?.get([PROFILES_STORAGE_KEY, deps.legacyOptionsKey])
    .catch(() => undefined);
  const managedPolicy = await readManagedEnterprisePolicy(
    deps.chromeApi?.storage?.managed,
    deps.enterprisePolicyKey
  );

  return resolveProfilesState({
    rawProfilesStore: local?.[PROFILES_STORAGE_KEY],
    rawLegacyOptions: local?.[deps.legacyOptionsKey],
    managed: parseManagedProfilesPolicy(managedPolicy)
  });
}

function discardDraft(editor: Editor): void {
  const { state } = editor;
  state.draft = structuredClone(state.profilesState.store);
  state.importPreview = undefined;
  state.status = undefined;
  closeProfileForm(state);
  render(editor);
  resetBaseline(editor);
  editor.deps.onChange?.();
}

/** The baseline goes through the same DOM read-back as later edits, so it compares equal. */
function resetBaseline(editor: Editor): void {
  syncDraftFromDom(editor);
  editor.state.baseline = stableJson(editor.state.draft);
}

function isDirty(editor: Editor): boolean {
  syncDraftFromDom(editor);
  return stableJson(editor.state.draft) !== editor.state.baseline;
}

function buildCatalog(state: EditorState): RecordingProfile[] {
  const userIds = new Set(state.draft.profiles.map((profile) => profile.id));

  return [
    ...state.draft.profiles,
    ...state.profilesState.catalog.filter(
      (profile) => isReadOnlyProfileId(profile.id) && !userIds.has(profile.id)
    )
  ];
}

function renderNotices(state: EditorState, catalog: RecordingProfile[], t: Translate) {
  const notices = [
    ...(catalog.some((profile) => profile.id.startsWith("managed:"))
      ? [t("optionsProfilesManagedNotice")]
      : []),
    ...(state.profilesState.issues.length > 0
      ? [t("optionsProfilesIssues", { issues: describeIssues(state.profilesState.issues) })]
      : [])
  ].map((text) => el("p", { className: "wb-notice", text }));

  return state.status
    ? [
        ...notices,
        el("p", {
          className: state.status.error ? "wb-notice wb-notice--error" : "wb-notice",
          text: state.status.text,
          attrs: { role: state.status.error ? "alert" : "status" },
          dataset: { profilesStatus: "" }
        })
      ]
    : notices;
}

function render(editor: Editor): void {
  const { state, slots, deps } = editor;
  const { t } = deps;
  const catalog = buildCatalog(state);
  const editing = state.draft.profiles.find((profile) => profile.id === state.editingId);

  slots.profiles.replaceChildren(
    el("div", { className: "wb-profiles wb-profiles-layout" }, [
      el("div", { className: "wb-profiles__list-col" }, [
        ...renderNotices(state, catalog, t),
        el(
          "ul",
          { className: "wb-profiles__list" },
          catalog.map((profile) =>
            createProfileCard({
              profile,
              defaultProfileId: state.draft.defaultProfileId,
              editing: profile.id === state.editingId,
              t
            })
          )
        )
      ]),
      el(
        "div",
        { className: "wb-profiles__editor-col" },
        editing
          ? [createProfileForm(editing, t)]
          : [el("p", { className: "wb-empty", text: t("optionsProfileEditorEmpty") })]
      )
    ])
  );

  const rulesView = {
    rules: sortRulesForDisplay(state.draft.rules),
    catalog,
    openRuleIds: state.openRuleIds,
    extendedCaptureHosts: state.draft.extendedCaptureHosts,
    test: { ...state.test, result: runTester(editor, catalog) },
    t
  };
  slots.rules.replaceChildren(
    el("div", { className: "wb-rules-layout" }, [
      createRulesList(rulesView),
      createRuleTester(rulesView)
    ])
  );
  slots.sandbox.replaceChildren(createSandboxPanel({ catalog, sandbox: state.sandbox, t }));
  slots.transfer.replaceChildren(
    createTransferPanel({
      ...(state.importPreview ? { importPreview: state.importPreview } : {}),
      t
    })
  );
  slots.transfer
    .querySelector<HTMLInputElement>('input[name="profilesImport"]')
    ?.addEventListener("change", (event) => {
      void importFile(editor, event.currentTarget as HTMLInputElement);
    });
  validateRuleTextFields(slots.rules, t);
}

function runTester(editor: Editor, catalog = buildCatalog(editor.state)) {
  const { state } = editor;

  return state.test.url.trim()
    ? testRulesForUrl({
        state: state.profilesState,
        draft: state.draft,
        catalog,
        url: state.test.url,
        incognito: state.test.incognito,
        enterpriseSiteAllowlist: state.enterpriseSiteAllowlist,
        ...(state.test.title.trim() ? { title: state.test.title } : {})
      })
    : undefined;
}

function refreshTester(editor: Editor): void {
  const { state, root, deps } = editor;
  state.test = {
    url: readField(root, "testUrl"),
    title: readField(root, "testTitle"),
    incognito: root.querySelector<HTMLInputElement>("input[name='testIncognito']")?.checked === true
  };
  syncRulesFromDom(editor);
  root
    .querySelector<HTMLElement>("[data-rule-test-result]")
    ?.replaceChildren(...describeTestResult(runTester(editor), deps.t));
}

function handleAction(editor: Editor, target: HTMLElement, action: string, update: Update): void {
  const { state } = editor;
  const profileId = target.closest<HTMLElement>("[data-profile-id]")?.dataset.profileId ?? "";
  const ruleIndex = Number(target.closest<HTMLElement>("[data-rule-index]")?.dataset.ruleIndex);

  if (blocksLeavingProfileForm(action, editor.root)) {
    return;
  }

  switch (action) {
    case "profile-edit":
      return update(() => openProfileForm(state, profileId));
    case "profile-duplicate":
      return update(() => {
        const source = buildCatalog(state).find((entry) => entry.id === profileId);

        if (source) {
          const result = duplicateIntoStore(state.draft, source);
          state.draft = result.store;
          openProfileForm(state, result.id);
        }
      });
    case "profile-default":
      return update(() => {
        state.draft = { ...state.draft, defaultProfileId: profileId };
      });
    case "profile-delete":
      void confirmProfileDelete(editor, profileId).then((confirmed) => {
        if (confirmed) {
          update(() => {
            state.draft = deleteProfileFromStore(state.draft, profileId);
            closeProfileForm(state);
          });
        }
      });
      return;
    case "profile-apply":
      return update(() => closeProfileForm(state));
    case "profile-cancel":
      return update(() => cancelProfileForm(state), { discardFormEdits: true });
    case "rule-add":
      return update(() => {
        const rule = newRule(state);
        state.draft = { ...state.draft, rules: [...state.draft.rules, rule] };
        state.openRuleIds.add(rule.id);
      });
    case "rule-delete":
      return update(() => {
        const ruleId = target.closest<HTMLElement>("[data-rule-id]")?.dataset.ruleId;
        state.draft = {
          ...state.draft,
          rules: state.draft.rules.filter((rule) => rule.id !== ruleId)
        };
      });
    case "rule-up":
    case "rule-down":
      return update(() => {
        const to = ruleIndex + (action === "rule-up" ? -1 : 1);
        state.draft = {
          ...state.draft,
          rules: reorderRules(state.draft.rules, ruleIndex, to, shownRuleIds(editor.root))
        };
      });
    case "rule-toggle":
      return toggleRule(state, target);
    case "profiles-export":
      syncDraftFromDom(editor);
      return downloadExport(state.draft);
    case "profiles-import-apply":
      return update(() => {
        if (state.importPreview) {
          state.draft = state.importPreview.next;
          state.importPreview = undefined;
          closeProfileForm(state);
        }
      });
    case "sandbox-run":
      return update(() => {
        state.sandbox = runRedactionSandbox(state.sandbox, buildCatalog(state), editor.deps.t);
      });
  }
}

function bindEditor(editor: Editor): void {
  const { root, deps } = editor;
  // Every action first keeps what is typed in the page (rules, hosts, the open profile form).
  const update: Update = (mutate, options = {}) => {
    const invalidRanges = captureInvalidRangeInputs(root, {
      includeProfileForm: !options.discardFormEdits
    });
    syncRulesFromDom(editor);
    editor.state.sandbox = readSandboxInputs(root, editor.state.sandbox);

    if (!options.discardFormEdits) {
      syncOpenProfileForm(editor);
    }

    mutate();
    // Edits made after picking the file are part of what the import replaces: list them too.
    refreshImportPreview(editor.state, deps.t);
    const rerender = (): void => {
      render(editor);
      restoreInvalidRangeInputs(root, invalidRanges, deps.t);
    };
    preserveFocus(root, rerender, { scopeAttributes: FOCUS_SCOPES });
    deps.onChange?.();
  };

  root.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    const action = target?.dataset.action;

    if (target && action && root.contains(target)) {
      handleAction(editor, target, action, update);
    }
  });
  root.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | null;

    if (!target) {
      return;
    }

    if (TESTER_FIELDS.has(target.name)) {
      refreshTester(editor);
      return;
    }

    if (target.type === "number" && target.closest(".wb-profiles__form, .wb-profiles__rule")) {
      validateRangeInput(target, deps.t);
    }

    validateRuleTextInput(target, deps.t);

    deps.onChange?.();
  });
  root.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;

    if (target && TESTER_FIELDS.has(target.name)) {
      refreshTester(editor);
      return;
    }

    if (
      target?.name !== "profilesImport" &&
      target?.closest("[data-profile-form], .wb-rules-panel")
    ) {
      deps.onChange?.();
    }
  });
  bindRuleDragging(root, (from, to, shownIds) =>
    update(() => {
      editor.state.draft = {
        ...editor.state.draft,
        rules: reorderRules(editor.state.draft.rules, from, to, shownIds)
      };
    })
  );
}

/** Rows that tell apart equal buttons ("Move up" of each rule) when focus is restored. */
const FOCUS_SCOPES = ["data-rule-id", "data-profile-id"];

/** Deleting a profile also deletes the rules that use it; those sit in another section. */
async function confirmProfileDelete(editor: Editor, profileId: string): Promise<boolean> {
  syncRulesFromDom(editor);
  const { state, deps } = editor;
  const ruleCount = state.draft.rules.filter((rule) => rule.profileId === profileId).length;

  if (ruleCount === 0) {
    return true;
  }

  const name = state.draft.profiles.find((profile) => profile.id === profileId)?.name ?? profileId;

  return openConfirmDialog({
    title: deps.t("optionsProfileDeleteTitle", { name }),
    body: deps.t("optionsProfileDeleteRules", { count: ruleCount }),
    acceptLabel: deps.t("optionsProfileDelete"),
    cancelLabel: deps.t("optionsProfileCancel"),
    acceptVariant: "danger"
  });
}

/** Inputs of the Test URL panel: they re-run the test and are not part of the draft. */
const TESTER_FIELDS = new Set(["testUrl", "testTitle", "testIncognito"]);

function toggleRule(state: EditorState, toggle: HTMLElement): void {
  const row = toggle.closest<HTMLElement>("[data-rule-id]");
  const ruleId = row?.dataset.ruleId;
  const body = row?.querySelector<HTMLElement>(".wb-rule__body");

  if (!ruleId || !body) {
    return;
  }

  const open = body.hidden;
  body.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));

  if (open) {
    state.openRuleIds.add(ruleId);
  } else {
    state.openRuleIds.delete(ruleId);
  }
}

async function importFile(editor: Editor, input: HTMLInputElement): Promise<void> {
  const { state, deps } = editor;
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    syncDraftFromDom(editor);
    const preview = previewProfilesImport(text, state.draft);
    state.importPreview = preview.ok ? { text, next: preview.next, diff: preview.diff } : undefined;
    state.status = preview.ok
      ? undefined
      : { text: deps.t("optionsProfilesError", { error: preview.error }), error: true };
  } catch (error) {
    state.importPreview = undefined;
    state.status = {
      text: deps.t("optionsProfilesError", {
        error: error instanceof Error ? error.message : String(error)
      }),
      error: true
    };
  }

  render(editor);
}

function refreshImportPreview(state: EditorState, t: Translate): void {
  if (!state.importPreview) {
    return;
  }

  const result = previewProfilesImport(state.importPreview.text, state.draft);

  if (result.ok) {
    state.importPreview = { ...state.importPreview, diff: result.diff };
  } else {
    state.importPreview = undefined;
    state.status = { text: t("optionsProfilesError", { error: result.error }), error: true };
  }
}

function openProfileForm(state: EditorState, id: string): void {
  const profile = state.draft.profiles.find((entry) => entry.id === id);

  state.editingId = id;
  state.editingSnapshot = profile ? structuredClone(profile) : undefined;
}

function closeProfileForm(state: EditorState): void {
  state.editingId = undefined;
  state.editingSnapshot = undefined;
}

/** Edits kept by other actions while the form was open are rolled back too. */
function cancelProfileForm(state: EditorState): void {
  const snapshot = state.editingSnapshot;

  if (snapshot) {
    state.draft = {
      ...state.draft,
      profiles: state.draft.profiles.map((entry) => (entry.id === snapshot.id ? snapshot : entry))
    };
  }

  closeProfileForm(state);
}

function syncDraftFromDom(editor: Editor): void {
  syncRulesFromDom(editor);
  syncOpenProfileForm(editor);
}

/** Folds the open profile form into the draft; the form stays open. */
function syncOpenProfileForm(editor: Editor): void {
  const { state } = editor;
  const form = editor.root.querySelector<HTMLFormElement>(".wb-profiles__form");
  const profile = state.draft.profiles.find((entry) => entry.id === state.editingId);

  if (!form || !profile) {
    return;
  }

  const next = applyProfileFormValues(profile, {
    name: readField(form, "name"),
    base: readField(form, "base"),
    categories: Object.fromEntries(
      CAPTURE_CATEGORY_KEYS.map((key) => [key, readField(form, `category-${key}`)])
    ),
    blockedSelectors: readField(form, "blockedSelectors"),
    unmaskSelectors: readField(form, "unmaskSelectors"),
    redactHeaders: readField(form, "redactHeaders"),
    redactBodyPatterns: readField(form, "redactBodyPatterns"),
    bodyMimeAllowlist: readField(form, "bodyMimeAllowlist"),
    bodyMaxBytes: readField(form, "bodyMaxBytes"),
    includeUrls: readField(form, "includeUrls"),
    excludeUrls: readField(form, "excludeUrls"),
    mousemoveHz: readField(form, "mousemoveHz"),
    visual: readField(form, "visual"),
    requireEncryption: readCheckbox(form, "requireEncryption"),
    blockOnFindings: readCheckbox(form, "blockOnFindings")
  });

  state.draft = {
    ...state.draft,
    profiles: state.draft.profiles.map((entry) => (entry.id === profile.id ? next : entry))
  };
}

/** Rule rows and the extended host list are plain inputs; fold them into the draft. */
function syncRulesFromDom(editor: Editor): void {
  const { state, root } = editor;
  const rules: ProfileRule[] = [
    ...root.querySelectorAll<HTMLElement>(".wb-profiles__rule")
  ].flatMap((row) => {
    const id = row.dataset.ruleId;

    return id
      ? [
          ruleFromFormValues({
            id,
            name: readField(row, "ruleName"),
            profileId: readField(row, "ruleProfile"),
            priority: readField(row, "rulePriority"),
            enabled: readCheckbox(row, "ruleEnabled"),
            hosts: readField(row, "ruleHosts"),
            paths: readField(row, "rulePaths"),
            query: readField(row, "ruleQuery"),
            titleRegex: readField(row, "ruleTitleRegex"),
            selectorPresent: readField(row, "ruleSelector"),
            metaName: readField(row, "ruleMetaName"),
            metaValue: readField(row, "ruleMetaValue"),
            incognito: readField(row, "ruleIncognito")
          })
        ]
      : [];
  });
  const hostsField = root.querySelector<HTMLInputElement>('[name="extendedCaptureHosts"]');

  state.draft = {
    ...state.draft,
    rules,
    extendedCaptureHosts: hostsField
      ? hostsField.value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : state.draft.extendedCaptureHosts
  };
}

function newRule(state: EditorState): ProfileRule {
  return {
    id: createUniqueId(
      "rule",
      state.draft.rules.map((rule) => rule.id)
    ),
    profileId: state.draft.defaultProfileId,
    priority: 0,
    enabled: true,
    match: {}
  };
}

async function saveDraft(editor: Editor): Promise<void> {
  const { state, deps } = editor;

  try {
    const serialized = serializeProfilesStore(state.draft);
    await deps.chromeApi?.storage?.local.set({ [PROFILES_STORAGE_KEY]: serialized });
    state.profilesState = await loadState(deps);
    state.draft = structuredClone(state.profilesState.store);
    state.status = {
      text: deps.t("optionsProfilesSaved", { time: new Date().toLocaleTimeString(deps.locale) }),
      error: false
    };
  } catch (error) {
    state.status = {
      text: deps.t("optionsProfilesError", {
        error: error instanceof Error ? error.message : String(error)
      }),
      error: true
    };
  }
}

function downloadExport(store: RecordingProfilesStore): void {
  const blob = new Blob([JSON.stringify(createProfilesExportFile(store), null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { attrs: { href: url, download: "webblackbox-profiles.json" } });

  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
