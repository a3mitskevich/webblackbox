import type { ChromeApi } from "../shared/chrome-api.js";
import type { ExtensionMessageKey } from "../shared/i18n.js";
import { readManagedEnterprisePolicy } from "../shared/options-storage.js";
import { previewRedaction, type RedactionSandboxKind } from "../shared/redaction-sandbox.js";
import { CAPTURE_CATEGORY_KEYS, CAPTURE_CATEGORY_LEVELS } from "../shared/profiles/categories.js";
import {
  DEFAULT_PROFILE_ID,
  isReadOnlyProfileId,
  PROFILES_STORAGE_KEY,
  type ProfileRule,
  type RecordingProfile,
  type RecordingProfilesStore
} from "../shared/profiles/model.js";
import { isExtendedCaptureProfile } from "../shared/profiles/resolve.js";
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
import {
  button,
  el,
  labeledCheckbox,
  labeledInput,
  labeledSelect,
  labeledTextarea,
  readCheckbox,
  readField
} from "./dom.js";
import {
  applyProfileFormValues,
  createUniqueId,
  deleteProfileFromStore,
  duplicateIntoStore,
  formatQueryLines,
  joinLines,
  ruleFromFormValues
} from "./profile-form-model.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type ProfilesEditorDeps = {
  chromeApi: ChromeApi | null;
  t: Translate;
  locale: string;
  legacyOptionsKey: string;
  enterprisePolicyKey: string;
};

export type ProfilesEditorHandle = {
  /** Folds a general settings save into the draft's Default profile. */
  applyGeneralOptions(payload: unknown): void;
};

type EditorState = {
  profilesState: ProfilesState;
  draft: RecordingProfilesStore;
  editingId?: string;
  /** The edited profile as it was when its form opened; Cancel restores it. */
  editingSnapshot?: RecordingProfile;
  importPreview?: { next: RecordingProfilesStore; diff: ProfilesDiff };
  status?: { text: string; error: boolean };
  sandbox: { profileId: string; kind: RedactionSandboxKind; text: string; output?: string };
};

const SANDBOX_KINDS: Array<{ value: RedactionSandboxKind; key: ExtensionMessageKey }> = [
  { value: "body", key: "optionsSandboxKindBody" },
  { value: "event", key: "optionsSandboxKindEvent" },
  { value: "headers", key: "optionsSandboxKindHeaders" },
  { value: "url", key: "optionsSandboxKindUrl" }
];

/**
 * Minimal profiles & rules editor for the options page. All logic lives in pure helpers
 * (profile-form-model, shared/profiles/*) so the planned settings redesign can replace this view.
 */
export async function mountProfilesEditor(
  container: HTMLElement,
  deps: ProfilesEditorDeps
): Promise<ProfilesEditorHandle> {
  const profilesState = await loadState(deps);
  const editor: EditorState = {
    profilesState,
    draft: structuredClone(profilesState.store),
    sandbox: { profileId: profilesState.store.defaultProfileId, kind: "body", text: "" }
  };
  const rerender = (): void => render(container, editor, deps, rerender);

  rerender();

  return {
    applyGeneralOptions: (payload) => {
      const card = container.querySelector<HTMLElement>(".wb-profiles");

      if (card) {
        syncDraftFromDom(card, editor);
      }

      editor.draft = syncDefaultProfileWithLegacyOptions(editor.draft, payload);
      // The general save is already stored; Cancel must not roll it back.
      const snapshot = editor.editingSnapshot;
      editor.editingSnapshot = snapshot
        ? syncDefaultProfileWithLegacyOptions({ ...editor.draft, profiles: [snapshot] }, payload)
            .profiles[0]
        : undefined;
      rerender();
    }
  };
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

function render(
  container: HTMLElement,
  editor: EditorState,
  deps: ProfilesEditorDeps,
  rerender: () => void
): void {
  const { t } = deps;
  const catalog = buildCatalog(editor);
  const card = el("section", { className: "card wb-options-card wb-profiles" });

  card.append(
    el("h2", { className: "wb-options-section-title", text: t("optionsProfilesTitle") }),
    el("p", { className: "wb-options-help", text: t("optionsProfilesHint") })
  );

  if (catalog.some((profile) => profile.id.startsWith("managed:"))) {
    card.append(el("p", { className: "wb-options-help", text: t("optionsProfilesManagedNotice") }));
  }

  if (editor.profilesState.issues.length > 0) {
    card.append(
      el("p", {
        className: "wb-options-help",
        text: t("optionsProfilesIssues", { issues: describeIssues(editor.profilesState.issues) })
      })
    );
  }

  card.append(createProfileList(editor, catalog, t));

  const editing = editor.draft.profiles.find((profile) => profile.id === editor.editingId);

  if (editing) {
    card.append(createProfileForm(editing, t));
  }

  card.append(createRulesSection(editor, catalog, t), createTransferSection(editor, t));

  if (editor.status) {
    card.append(
      el("p", {
        className: editor.status.error
          ? "wb-options-status wb-options-status--error"
          : "wb-options-status",
        text: editor.status.text,
        dataset: { profilesStatus: "" }
      })
    );
  }

  card.append(createSandboxSection(editor, catalog, t));
  container.replaceChildren(card);
  bindEditor(card, editor, deps, rerender);
}

function buildCatalog(editor: EditorState): RecordingProfile[] {
  const userIds = new Set(editor.draft.profiles.map((profile) => profile.id));

  return [
    ...editor.draft.profiles,
    ...editor.profilesState.catalog.filter(
      (profile) => isReadOnlyProfileId(profile.id) && !userIds.has(profile.id)
    )
  ];
}

function createProfileList(
  editor: EditorState,
  catalog: RecordingProfile[],
  t: Translate
): HTMLElement {
  const list = el("ul", { className: "wb-profiles__list" });

  for (const profile of catalog) {
    const readOnly = isReadOnlyProfileId(profile.id);
    const badges = [
      profile.id === editor.draft.defaultProfileId ? t("optionsProfileDefaultBadge") : "",
      readOnly ? t("optionsProfileReadOnlyBadge") : "",
      isExtendedCaptureProfile(profile) ? t("optionsProfileExtendedBadge") : ""
    ].filter(Boolean);
    const actions = el("span", { className: "wb-profiles__actions" });

    if (!readOnly) {
      actions.append(button(t("optionsProfileEdit"), "profile-edit"));
    }

    actions.append(button(t("optionsProfileDuplicate"), "profile-duplicate"));

    if (profile.id !== editor.draft.defaultProfileId) {
      actions.append(button(t("optionsProfileMakeDefault"), "profile-default"));
    }

    if (!readOnly && profile.id !== DEFAULT_PROFILE_ID) {
      actions.append(button(t("optionsProfileDelete"), "profile-delete", "muted"));
    }

    list.append(
      el("li", { className: "wb-profiles__row", dataset: { profileId: profile.id } }, [
        el("strong", { text: profile.name }),
        el("span", { className: "wb-profiles__badges", text: badges.join(" · ") }),
        el("span", { className: "wb-options-help", text: profile.description ?? "" }),
        actions
      ])
    );
  }

  return list;
}

function createProfileForm(profile: RecordingProfile, t: Translate): HTMLElement {
  const form = el("form", { className: "wb-options-inset wb-profiles__form" });
  const matrix = el("fieldset", { className: "wb-profiles__matrix" }, [
    el("legend", { text: t("optionsProfileCategories") })
  ]);

  for (const key of CAPTURE_CATEGORY_KEYS) {
    matrix.append(
      labeledSelect(
        key,
        `category-${key}`,
        profile.categories[key],
        (CAPTURE_CATEGORY_LEVELS[key] as readonly string[]).map((level) => ({
          value: level,
          label: level
        }))
      )
    );
  }

  form.append(
    labeledInput(t("optionsProfileName"), "name", profile.name),
    labeledSelect(t("optionsProfileBase"), "base", profile.base, [
      { value: "lite", label: "Lite" },
      { value: "full", label: "Full" }
    ]),
    matrix,
    labeledTextarea(
      t("optionsBlockedSelectors"),
      "blockedSelectors",
      joinLines(profile.redaction.blockedSelectors)
    ),
    labeledTextarea(
      t("optionsProfileUnmaskSelectors"),
      "unmaskSelectors",
      joinLines(profile.unmaskSelectors)
    ),
    labeledTextarea(
      t("optionsRedactedHeaders"),
      "redactHeaders",
      joinLines(profile.redaction.redactHeaders)
    ),
    labeledTextarea(
      t("optionsBodySensitivePatterns"),
      "redactBodyPatterns",
      joinLines(profile.redaction.redactBodyPatterns)
    ),
    labeledTextarea(
      t("optionsProfileBodyMimeAllowlist"),
      "bodyMimeAllowlist",
      joinLines(profile.network.bodyMimeAllowlist)
    ),
    labeledInput(
      t("optionsProfileBodyMaxBytes"),
      "bodyMaxBytes",
      profile.network.bodyMaxBytes?.toString() ?? "",
      "number"
    ),
    labeledTextarea(
      t("optionsProfileIncludeUrls"),
      "includeUrls",
      joinLines(profile.network.includeUrls)
    ),
    labeledTextarea(
      t("optionsProfileExcludeUrls"),
      "excludeUrls",
      joinLines(profile.network.excludeUrls)
    ),
    labeledInput(
      t("optionsProfileMousemoveHz"),
      "mousemoveHz",
      profile.pointer.mousemoveHz?.toString() ?? "",
      "number"
    ),
    labeledSelect(t("optionsProfileVisual"), "visual", profile.visual ?? "", [
      { value: "", label: t("optionsProfileVisualPopup") },
      { value: "screenshots", label: t("popupFullVisualScreenshots") },
      { value: "recording", label: t("popupFullVisualRecording") },
      { value: "both", label: t("popupFullVisualBoth") },
      { value: "none", label: t("popupFullVisualNone") }
    ]),
    labeledCheckbox(
      t("optionsProfileRequireEncryption"),
      "requireEncryption",
      profile.export.encryption === "required"
    ),
    labeledCheckbox(
      t("optionsProfileBlockOnFindings"),
      "blockOnFindings",
      profile.export.privacyScanner === "block"
    ),
    el("div", { className: "wb-options-actions" }, [
      button(t("optionsProfileSave"), "profile-apply", "brand"),
      button(t("optionsProfileCancel"), "profile-cancel", "muted")
    ])
  );

  return form;
}

function createRulesSection(
  editor: EditorState,
  catalog: RecordingProfile[],
  t: Translate
): HTMLElement {
  const section = el("section", { className: "wb-options-inset wb-profiles__rules" }, [
    el("h3", { className: "wb-options-section-title", text: t("optionsRulesTitle") }),
    el("p", { className: "wb-options-help", text: t("optionsRulesHint") })
  ]);
  const profileOptions = catalog.map((profile) => ({ value: profile.id, label: profile.name }));

  for (const rule of editor.draft.rules) {
    // A rule may target a profile that was deleted or dropped from managed policy; keep its id
    // selectable so the next sync does not blank it and block saving.
    const ruleProfileOptions = catalog.some((profile) => profile.id === rule.profileId)
      ? profileOptions
      : [
          ...profileOptions,
          { value: rule.profileId, label: t("optionsRuleProfileMissing", { id: rule.profileId }) }
        ];

    section.append(
      el("fieldset", { className: "wb-profiles__rule", dataset: { ruleId: rule.id } }, [
        labeledInput(t("optionsRuleName"), "ruleName", rule.name ?? ""),
        labeledSelect(t("optionsRuleProfile"), "ruleProfile", rule.profileId, ruleProfileOptions),
        labeledInput(t("optionsRulePriority"), "rulePriority", String(rule.priority), "number"),
        labeledCheckbox(t("optionsRuleEnabled"), "ruleEnabled", rule.enabled),
        labeledTextarea(t("optionsRuleHosts"), "ruleHosts", joinLines(rule.match.hosts ?? [])),
        labeledTextarea(t("optionsRulePaths"), "rulePaths", joinLines(rule.match.paths ?? [])),
        labeledTextarea(t("optionsRuleQuery"), "ruleQuery", formatQueryLines(rule.match.query)),
        labeledInput(t("optionsRuleTitleRegex"), "ruleTitleRegex", rule.match.titleRegex ?? ""),
        labeledInput(t("optionsRuleSelector"), "ruleSelector", rule.match.selectorPresent ?? ""),
        labeledInput(t("optionsRuleMetaName"), "ruleMetaName", rule.match.metaTag?.name ?? ""),
        labeledInput(t("optionsRuleMetaValue"), "ruleMetaValue", rule.match.metaTag?.value ?? ""),
        labeledSelect(
          t("optionsRuleIncognito"),
          "ruleIncognito",
          rule.match.incognito === undefined ? "any" : rule.match.incognito ? "only" : "never",
          [
            { value: "any", label: t("optionsRuleIncognitoAny") },
            { value: "only", label: t("optionsRuleIncognitoOnly") },
            { value: "never", label: t("optionsRuleIncognitoNever") }
          ]
        ),
        button(t("optionsProfileDelete"), "rule-delete", "muted")
      ])
    );
  }

  section.append(
    button(t("optionsRuleAdd"), "rule-add"),
    labeledTextarea(
      t("optionsExtendedHosts"),
      "extendedCaptureHosts",
      joinLines(editor.draft.extendedCaptureHosts)
    )
  );

  return section;
}

function createTransferSection(editor: EditorState, t: Translate): HTMLElement {
  const fileInput = el("input", {
    attrs: { type: "file", accept: "application/json,.json", name: "profilesImport" }
  });
  const section = el("div", { className: "wb-options-actions wb-profiles__transfer" }, [
    button(t("optionsProfilesSave"), "profiles-save", "brand"),
    button(t("optionsProfilesExport"), "profiles-export"),
    el("label", { className: "wb-btn wb-btn--surface" }, [t("optionsProfilesImport"), fileInput])
  ]);

  if (editor.importPreview) {
    const { diff } = editor.importPreview;
    section.append(
      el("p", {
        className: "wb-options-help",
        dataset: { importSummary: "" },
        text: diff.hasChanges
          ? t("optionsProfilesImportSummary", {
              added: diff.profiles.added.length,
              removed: diff.profiles.removed.length,
              changed: diff.profiles.changed.length,
              rulesAdded: diff.rules.added.length,
              rulesRemoved: diff.rules.removed.length,
              rulesChanged: diff.rules.changed.length
            })
          : t("optionsProfilesImportNoChanges")
      }),
      ...describeImportDetails(diff, t).map((text) =>
        el("p", { className: "wb-options-help", dataset: { importDetail: "" }, text })
      ),
      button(t("optionsProfilesImportApply"), "profiles-import-apply", "accent")
    );
  }

  return section;
}

/** Lines a reviewer needs before applying an import: what changes beyond the counts. */
function describeImportDetails(diff: ProfilesDiff, t: Translate): string[] {
  const changed = [...diff.profiles.changed, ...diff.rules.changed].map(
    (entry) => `${entry.name} (${entry.fields.join(", ")})`
  );
  const hosts = diff.extendedCaptureHosts;

  return [
    ...(diff.defaultProfileId ? [t("optionsProfilesImportDefault", diff.defaultProfileId)] : []),
    ...(hosts.added.length > 0 || hosts.removed.length > 0
      ? [
          t("optionsProfilesImportHosts", {
            added: hosts.added.join(", ") || "—",
            removed: hosts.removed.join(", ") || "—"
          })
        ]
      : []),
    ...(changed.length > 0
      ? [t("optionsProfilesImportChanged", { items: changed.join("; ") })]
      : [])
  ];
}

function createSandboxSection(
  editor: EditorState,
  catalog: RecordingProfile[],
  t: Translate
): HTMLElement {
  const input = el("textarea", {
    className: "wb-options-textarea",
    attrs: { name: "sandboxInput", rows: "5" }
  });
  input.value = editor.sandbox.text;

  return el("section", { className: "wb-options-inset wb-profiles__sandbox" }, [
    el("h3", { className: "wb-options-section-title", text: t("optionsSandboxTitle") }),
    el("p", { className: "wb-options-help", text: t("optionsSandboxHint") }),
    labeledSelect(
      t("optionsRuleProfile"),
      "sandboxProfile",
      editor.sandbox.profileId,
      catalog.map((profile) => ({ value: profile.id, label: profile.name }))
    ),
    labeledSelect(
      t("optionsSandboxTitle"),
      "sandboxKind",
      editor.sandbox.kind,
      SANDBOX_KINDS.map((kind) => ({ value: kind.value, label: t(kind.key) }))
    ),
    input,
    button(t("optionsSandboxRun"), "sandbox-run"),
    el("pre", {
      className: "wb-profiles__sandbox-output",
      text: editor.sandbox.output ?? "",
      dataset: { sandboxOutput: "" }
    })
  ]);
}

function bindEditor(
  card: HTMLElement,
  editor: EditorState,
  deps: ProfilesEditorDeps,
  rerender: () => void
): void {
  const { t } = deps;
  const profileIdOf = (target: Element): string =>
    target.closest<HTMLElement>("[data-profile-id]")?.dataset.profileId ?? "";
  const findProfile = (id: string): RecordingProfile | undefined =>
    buildCatalog(editor).find((profile) => profile.id === id);
  // Every action first keeps what is typed in the page (rules, hosts, the open profile form).
  const update = (mutate: () => void, options: { discardFormEdits?: boolean } = {}): void => {
    syncRulesFromDom(card, editor);

    if (!options.discardFormEdits) {
      syncOpenProfileForm(card, editor);
    }

    mutate();
    rerender();
  };

  card.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
    const action = target?.dataset.action;

    if (!target || !action) {
      return;
    }

    switch (action) {
      case "profile-edit":
        return update(() => openProfileForm(editor, profileIdOf(target)));
      case "profile-duplicate":
        return update(() => {
          const source = findProfile(profileIdOf(target));

          if (source) {
            const result = duplicateIntoStore(editor.draft, source);
            editor.draft = result.store;
            openProfileForm(editor, result.id);
          }
        });
      case "profile-default":
        return update(() => {
          editor.draft = { ...editor.draft, defaultProfileId: profileIdOf(target) };
        });
      case "profile-delete":
        return update(() => {
          editor.draft = deleteProfileFromStore(editor.draft, profileIdOf(target));
          closeProfileForm(editor);
        });
      case "profile-apply":
        return update(() => closeProfileForm(editor));
      case "profile-cancel":
        return update(() => cancelProfileForm(editor), { discardFormEdits: true });
      case "rule-add":
        return update(() => {
          editor.draft = { ...editor.draft, rules: [...editor.draft.rules, newRule(editor)] };
        });
      case "rule-delete":
        return update(() => {
          const ruleId = target.closest<HTMLElement>("[data-rule-id]")?.dataset.ruleId;
          editor.draft = {
            ...editor.draft,
            rules: editor.draft.rules.filter((rule) => rule.id !== ruleId)
          };
        });
      case "profiles-save":
        syncDraftFromDom(card, editor);
        void saveDraft(editor, deps).then(() => {
          // What was just saved is the new baseline for Cancel.
          if (editor.editingId && !editor.status?.error) {
            openProfileForm(editor, editor.editingId);
          }

          rerender();
        });
        return;
      case "profiles-export":
        syncDraftFromDom(card, editor);
        downloadExport(editor.draft);
        return;
      case "profiles-import-apply":
        return update(() => {
          if (editor.importPreview) {
            editor.draft = editor.importPreview.next;
            editor.importPreview = undefined;
            closeProfileForm(editor);
          }
        });
      case "sandbox-run":
        return update(() => runSandbox(card, editor, t));
    }
  });

  card
    .querySelector<HTMLInputElement>('input[name="profilesImport"]')
    ?.addEventListener("change", (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];

      if (!file) {
        return;
      }

      void file
        .text()
        .then((text) => {
          syncDraftFromDom(card, editor);
          const preview = previewProfilesImport(text, editor.draft);
          editor.importPreview = preview.ok
            ? { next: preview.next, diff: preview.diff }
            : undefined;
          editor.status = preview.ok
            ? undefined
            : { text: t("optionsProfilesError", { error: preview.error }), error: true };
        })
        .catch((error: unknown) => {
          editor.importPreview = undefined;
          editor.status = {
            text: t("optionsProfilesError", {
              error: error instanceof Error ? error.message : String(error)
            }),
            error: true
          };
        })
        .finally(rerender);
    });
}

function openProfileForm(editor: EditorState, id: string): void {
  const profile = editor.draft.profiles.find((entry) => entry.id === id);

  editor.editingId = id;
  editor.editingSnapshot = profile ? structuredClone(profile) : undefined;
}

function closeProfileForm(editor: EditorState): void {
  editor.editingId = undefined;
  editor.editingSnapshot = undefined;
}

/** Edits kept by other actions while the form was open are rolled back too. */
function cancelProfileForm(editor: EditorState): void {
  const snapshot = editor.editingSnapshot;

  if (snapshot) {
    editor.draft = {
      ...editor.draft,
      profiles: editor.draft.profiles.map((entry) => (entry.id === snapshot.id ? snapshot : entry))
    };
  }

  closeProfileForm(editor);
}

function syncDraftFromDom(card: HTMLElement, editor: EditorState): void {
  syncRulesFromDom(card, editor);
  syncOpenProfileForm(card, editor);
}

/** Folds the open profile form into the draft; the form stays open. */
function syncOpenProfileForm(card: HTMLElement, editor: EditorState): void {
  const form = card.querySelector<HTMLFormElement>(".wb-profiles__form");
  const profile = editor.draft.profiles.find((entry) => entry.id === editor.editingId);

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

  editor.draft = {
    ...editor.draft,
    profiles: editor.draft.profiles.map((entry) => (entry.id === profile.id ? next : entry))
  };
}

/** Rule rows and the extended host list are plain inputs; fold them into the draft. */
function syncRulesFromDom(card: HTMLElement, editor: EditorState): void {
  const rules: ProfileRule[] = [
    ...card.querySelectorAll<HTMLElement>(".wb-profiles__rule")
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
  const hostsField = card.querySelector<HTMLTextAreaElement>('[name="extendedCaptureHosts"]');

  editor.draft = {
    ...editor.draft,
    rules,
    extendedCaptureHosts: hostsField
      ? hostsField.value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : editor.draft.extendedCaptureHosts
  };
}

function newRule(editor: EditorState): ProfileRule {
  return {
    id: createUniqueId(
      "rule",
      editor.draft.rules.map((rule) => rule.id)
    ),
    profileId: editor.draft.defaultProfileId,
    priority: 0,
    enabled: true,
    match: {}
  };
}

async function saveDraft(editor: EditorState, deps: ProfilesEditorDeps): Promise<void> {
  try {
    const serialized = serializeProfilesStore(editor.draft);
    await deps.chromeApi?.storage?.local.set({ [PROFILES_STORAGE_KEY]: serialized });
    editor.profilesState = await loadState(deps);
    editor.draft = structuredClone(editor.profilesState.store);
    editor.status = {
      text: deps.t("optionsProfilesSaved", {
        time: new Date().toLocaleTimeString(deps.locale)
      }),
      error: false
    };
  } catch (error) {
    editor.status = {
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

function runSandbox(card: HTMLElement, editor: EditorState, t: Translate): void {
  const profileId = readField(card, "sandboxProfile");
  const kind = (SANDBOX_KINDS.find((entry) => entry.value === readField(card, "sandboxKind"))
    ?.value ?? "body") as RedactionSandboxKind;
  const text = readField(card, "sandboxInput");
  const profile = buildCatalog(editor).find((entry) => entry.id === profileId);

  editor.sandbox = { profileId, kind, text };

  if (!profile) {
    return;
  }

  const result = previewRedaction(
    { kind, text },
    { ...profile.redaction, unmaskSelectors: profile.unmaskSelectors }
  );

  editor.sandbox.output =
    result.error === "invalid-json"
      ? t("optionsSandboxInvalidJson")
      : result.changed
        ? result.output
        : t("optionsSandboxUnchanged");
}
