import type { ChromeApi } from "../shared/chrome-api.js";
import type { ExtensionMessageKey } from "../shared/i18n.js";
import {
  isReadOnlyProfileId,
  PROFILES_STORAGE_KEY,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "../shared/profiles/model.js";
import {
  describeIssues,
  serializeProfilesStore,
  syncDefaultProfileWithLegacyOptions,
  type ProfilesState
} from "../shared/profiles/storage.js";
import { previewProfilesImport, type ProfilesDiff } from "../shared/profiles/transfer.js";
import { openConfirmDialog } from "../shared/ui/dialogs.js";
import { preserveFocus } from "../shared/ui/focus.js";
import { el, readField } from "./dom.js";
import {
  changedItemIds,
  comparableStoreJson,
  diffEditorSections,
  guardEditorClose,
  markUnsavedItems,
  revertRule,
  type EditorChanges,
  type EditorCloseHost
} from "./editor-close-guard.js";
import { readProfileForm, readRulesFromDom } from "./editor-dom-read.js";
import {
  downloadProfilesExport,
  loadEnterpriseSiteAllowlist,
  loadProfilesState
} from "./editor-storage.js";
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
  createUniqueId,
  deleteProfileFromStore,
  duplicateIntoStore,
  reorderRules,
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
  /**
   * Saves everything unsaved on the page (a close prompt's "Save changes"); resolves true when
   * nothing is left unsaved. Without it the prompt saves the editor alone.
   */
  requestSave?: () => Promise<boolean>;
  /** False while the page blocks Save (an invalid field): close prompts then offer no Save. */
  canSave?: () => boolean;
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
  /** Which settings sections (profiles, rules) hold the unsaved changes. */
  changedSections(): EditorChanges;
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
  /** The draft as last loaded/saved, after one DOM round trip: what "unsaved" compares with. */
  savedStore: RecordingProfilesStore;
  /** Stable JSON of the open profile as its form first rendered; later edits differ from it. */
  formBaseline?: string;
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
  const profilesState = await loadProfilesState(deps);
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
      savedStore: structuredClone(profilesState.store)
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
      // Not an edit made in the form: it must not make closing the form ask.
      state.formBaseline = undefined;
      render(editor);
    },
    isDirty: () => isDirty(editor),
    changedSections: () => {
      syncDraftFromDom(editor);
      return diffEditorSections(editor.state.draft, editor.state.savedStore);
    },
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
    save: () => saveEditor(editor),
    reload: async () => {
      editor.state.profilesState = await loadProfilesState(deps);
      editor.state.enterpriseSiteAllowlist = await loadEnterpriseSiteAllowlist(deps);
      discardDraft(editor);
    },
    cancel: () => discardDraft(editor)
  };
}

async function saveEditor(editor: Editor): Promise<ProfilesSaveResult> {
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
}

function createDefaultSlots(root: HTMLElement): ProfilesEditorSlots {
  const slots = { profiles: el("div"), rules: el("div"), sandbox: el("div"), transfer: el("div") };
  root.append(slots.profiles, slots.rules, slots.sandbox, slots.transfer);
  return slots;
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
  editor.state.savedStore = structuredClone(editor.state.draft);
  refreshUnsavedMarks(editor);
}

function isDirty(editor: Editor): boolean {
  syncDraftFromDom(editor);
  return comparableStoreJson(editor.state.draft) !== comparableStoreJson(editor.state.savedStore);
}

/** "Unsaved" badges on the profile cards and rule rows, from what is typed in the page. */
function refreshUnsavedMarks(editor: Editor): void {
  syncDraftFromDom(editor);
  markUnsavedItems(editor.root, changedItemIds(editor.state.draft, editor.state.savedStore));
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

  if (editing && state.formBaseline === undefined) {
    syncOpenProfileForm(editor);
    const shown = state.draft.profiles.find((profile) => profile.id === state.editingId);
    state.formBaseline = shown ? stableJson(shown) : undefined;
  }

  markUnsavedItems(editor.root, changedItemIds(state.draft, state.savedStore));
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

function handleAction(
  editor: Editor,
  target: HTMLElement,
  action: string,
  update: Update,
  confirmed = false
): void {
  const { state } = editor;
  const profileId = target.closest<HTMLElement>("[data-profile-id]")?.dataset.profileId ?? "";
  const ruleIndex = Number(target.closest<HTMLElement>("[data-rule-index]")?.dataset.ruleIndex);

  if (blocksLeavingProfileForm(action, editor.root)) {
    return;
  }

  // Closing a profile form or a rule row with unsaved edits waits for the user's answer.
  if (
    !confirmed &&
    guardEditorClose(closeGuardHost(editor, update), target, action, () =>
      handleAction(editor, target, action, update, true)
    )
  ) {
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
      return downloadProfilesExport(state.draft);
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
    refreshUnsavedMarks(editor);
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
    refreshUnsavedMarks(editor);
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
      refreshUnsavedMarks(editor);
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

/** What the close prompts need from the editor, read when the action happens. */
function closeGuardHost(editor: Editor, update: Update): EditorCloseHost {
  const { state, deps } = editor;

  return {
    t: deps.t,
    canSave: deps.canSave?.() ?? true,
    save: deps.requestSave ?? (async () => (await saveEditor(editor)).ok),
    readDraft: () => {
      syncDraftFromDom(editor);
      return state.draft;
    },
    saved: state.savedStore,
    editingId: state.editingId,
    formBaseline: state.formBaseline,
    revertRule: (ruleId) =>
      update(() => {
        state.draft = revertRule(state.draft, state.savedStore, ruleId);
      }),
    collapseRule: (ruleId) => update(() => state.openRuleIds.delete(ruleId)),
    discardFormEdits: () => update(() => cancelProfileForm(state), { discardFormEdits: true })
  };
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
  state.formBaseline = undefined;
}

function closeProfileForm(state: EditorState): void {
  state.editingId = undefined;
  state.editingSnapshot = undefined;
  state.formBaseline = undefined;
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

  const next = readProfileForm(form, profile);
  state.draft = {
    ...state.draft,
    profiles: state.draft.profiles.map((entry) => (entry.id === profile.id ? next : entry))
  };
}

/** Rule rows and the extended host list are plain inputs; fold them into the draft. */
function syncRulesFromDom(editor: Editor): void {
  const { state, root } = editor;
  state.draft = {
    ...state.draft,
    ...readRulesFromDom(root, state.draft.extendedCaptureHosts)
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
    state.profilesState = await loadProfilesState(deps);
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
