import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { RecordingProfile, RecordingProfilesStore } from "../shared/profiles/model.js";
import { openChoiceDialog, openConfirmDialog, type DialogChoice } from "../shared/ui/dialogs.js";
import { stableJson } from "./profile-form-model.js";
import { ruleLabel } from "./rule-tester.js";

/**
 * Unsaved edits in the profiles & rules editor: which parts and items differ from the saved
 * store, the "Unsaved" item badges, and the prompts shown before a profile form or a rule row
 * with edits closes.
 */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type CloseChoice = "save" | "discard";

/** Which settings sections hold unsaved editor changes. */
export type EditorChanges = { profiles: boolean; rules: boolean };

export type ChangedItems = { profiles: ReadonlySet<string>; rules: ReadonlySet<string> };

/**
 * A profile as its form reads it back: redaction switches and lists the stored profile leaves
 * out get their defaults, so opening a form does not count as an edit.
 */
function comparableProfile(profile: RecordingProfile): RecordingProfile {
  const { redaction } = profile;

  return {
    ...profile,
    redaction: {
      ...redaction,
      contentRedaction: redaction.contentRedaction !== false,
      builtInHeuristics: redaction.builtInHeuristics !== false,
      redactQueryParams: redaction.redactQueryParams ?? [],
      redactStorageKeys: redaction.redactStorageKeys ?? [],
      valuePatterns: redaction.valuePatterns ?? []
    }
  };
}

/** Stable JSON of the store for "is anything unsaved" checks. */
export function comparableStoreJson(store: RecordingProfilesStore): string {
  return stableJson({ ...store, profiles: store.profiles.map(comparableProfile) });
}

/** `saved` is the store as loaded or saved, after the same DOM read-back as the draft. */
export function diffEditorSections(
  draft: RecordingProfilesStore,
  saved: RecordingProfilesStore
): EditorChanges {
  return {
    profiles:
      stableJson([draft.defaultProfileId, draft.profiles.map(comparableProfile)]) !==
      stableJson([saved.defaultProfileId, saved.profiles.map(comparableProfile)]),
    rules:
      stableJson([draft.rules, draft.extendedCaptureHosts]) !==
      stableJson([saved.rules, saved.extendedCaptureHosts])
  };
}

/** Ids of the profiles and rules that are new or differ from their saved version. */
export function changedItemIds(
  draft: RecordingProfilesStore,
  saved: RecordingProfilesStore
): ChangedItems {
  const changed = <TItem extends { id: string }>(
    items: TItem[],
    before: TItem[],
    comparable: (item: TItem) => unknown = (item) => item
  ) =>
    new Set(
      items
        .filter((item) => {
          const previous = before.find((entry) => entry.id === item.id);
          return !previous || stableJson(comparable(previous)) !== stableJson(comparable(item));
        })
        .map((item) => item.id)
    );

  return {
    profiles: changed(draft.profiles, saved.profiles, comparableProfile),
    rules: changed(draft.rules, saved.rules)
  };
}

/** The draft with one rule back at its saved version; a rule that was never saved is removed. */
export function revertRule(
  draft: RecordingProfilesStore,
  saved: RecordingProfilesStore,
  ruleId: string
): RecordingProfilesStore {
  const previous = saved.rules.find((rule) => rule.id === ruleId);

  return {
    ...draft,
    rules: previous
      ? draft.rules.map((rule) => (rule.id === ruleId ? structuredClone(previous) : rule))
      : draft.rules.filter((rule) => rule.id !== ruleId)
  };
}

/** Shows the "Unsaved" badge of every profile card and rule row in `changes`. */
export function markUnsavedItems(root: ParentNode, changes: ChangedItems): void {
  root.querySelectorAll<HTMLElement>("[data-unsaved-badge]").forEach((badge) => {
    const ruleId = badge.closest<HTMLElement>("[data-rule-id]")?.dataset.ruleId;
    const profileId = badge.closest<HTMLElement>("[data-profile-id]")?.dataset.profileId;
    const unsaved =
      ruleId !== undefined
        ? changes.rules.has(ruleId)
        : profileId !== undefined && changes.profiles.has(profileId);

    badge.hidden = !unsaved;
  });
}

/** Save changes / Discard changes / Keep editing; null means keep editing. */
export function askToCloseEditor(
  t: Translate,
  options: { title: string; body: string; canSave: boolean }
): Promise<CloseChoice | null> {
  const choices: Array<DialogChoice<CloseChoice>> = [
    {
      value: "discard",
      label: t("optionsDiscardChanges"),
      action: "editor-close-discard",
      variant: "danger"
    },
    ...(options.canSave
      ? [
          {
            value: "save" as const,
            label: t("optionsSave"),
            action: "editor-close-save",
            variant: "brand" as const,
            primary: true
          }
        ]
      : [])
  ];

  return openChoiceDialog<CloseChoice>({
    title: options.title,
    body: options.body,
    cancelLabel: t("optionsKeepEditing"),
    cancelAction: "editor-close-keep",
    choices
  });
}

export function confirmDiscardProfileEdits(t: Translate, name: string): Promise<boolean> {
  return openConfirmDialog({
    title: t("optionsProfileDiscardTitle", { name }),
    body: t("optionsProfileDiscardBody"),
    acceptLabel: t("optionsDiscardChanges"),
    cancelLabel: t("optionsKeepEditing"),
    acceptVariant: "danger"
  });
}

/**
 * Carries out the answer to a close prompt: discard then go on, or save then go on only when the
 * save left nothing unsaved. Keep editing does nothing.
 */
export async function resolveCloseChoice(
  choice: CloseChoice | null,
  actions: { save(): Promise<boolean>; discard(): void; proceed(): void }
): Promise<void> {
  if (choice === "discard") {
    actions.discard();
    actions.proceed();
  } else if (choice === "save" && (await actions.save())) {
    actions.proceed();
  }
}

/** The profiles editor as the close prompts see it. */
export type EditorCloseHost = {
  t: Translate;
  canSave: boolean;
  /** "Save changes": resolves true when nothing is left unsaved. */
  save(): Promise<boolean>;
  /** The draft after reading the page's inputs back. */
  readDraft(): RecordingProfilesStore;
  saved: RecordingProfilesStore;
  editingId: string | undefined;
  /** Stable JSON of the open profile as its form first rendered. */
  formBaseline: string | undefined;
  revertRule(ruleId: string): void;
  collapseRule(ruleId: string): void;
  /** Puts the open profile back as it was when its form opened, and closes the form. */
  discardFormEdits(): void;
};

/** Actions that close the open profile form (Cancel throws its edits away). */
const FORM_CLOSING_ACTIONS = new Set([
  "profile-edit",
  "profile-duplicate",
  "profile-apply",
  "profile-cancel"
]);

/**
 * Closing a profile form or a rule row that holds unsaved edits asks first. Returns true when
 * the action waits for the answer; `proceed` then runs it (unless the user keeps editing).
 */
export function guardEditorClose(
  host: EditorCloseHost,
  target: HTMLElement,
  action: string,
  proceed: () => void
): boolean {
  if (action === "rule-toggle") {
    return guardRuleClose(host, target);
  }

  const profileId = target.closest<HTMLElement>("[data-profile-id]")?.dataset.profileId;

  if (
    !FORM_CLOSING_ACTIONS.has(action) ||
    !host.editingId ||
    (action === "profile-edit" && profileId === host.editingId)
  ) {
    return false;
  }

  const profile = host.readDraft().profiles.find((entry) => entry.id === host.editingId);

  if (!profile || host.formBaseline === undefined || stableJson(profile) === host.formBaseline) {
    return false;
  }

  if (action === "profile-cancel") {
    void confirmDiscardProfileEdits(host.t, profile.name).then((discard) => {
      if (discard) {
        proceed();
      }
    });
    return true;
  }

  void askToCloseEditor(host.t, {
    title: host.t("optionsProfileCloseTitle", { name: profile.name }),
    body: host.t("optionsProfileCloseBody"),
    canSave: host.canSave
  }).then((choice) =>
    resolveCloseChoice(choice, { save: host.save, discard: host.discardFormEdits, proceed })
  );
  return true;
}

/** Collapsing an open rule row that is new or differs from its saved version. */
function guardRuleClose(host: EditorCloseHost, toggle: HTMLElement): boolean {
  const row = toggle.closest<HTMLElement>("[data-rule-id]");
  const ruleId = row?.dataset.ruleId ?? "";
  const closing = row?.querySelector<HTMLElement>(".wb-rule__body")?.hidden === false;
  const draft = host.readDraft();
  const rule = draft.rules.find((entry) => entry.id === ruleId);

  if (!row || !rule || !closing || !changedItemIds(draft, host.saved).rules.has(ruleId)) {
    return false;
  }

  const isNew = !host.saved.rules.some((entry) => entry.id === ruleId);
  void askToCloseEditor(host.t, {
    title: host.t("optionsRuleCloseTitle", { name: ruleLabel(rule) }),
    body: host.t(isNew ? "optionsRuleCloseBodyNew" : "optionsRuleCloseBody"),
    canSave: host.canSave
  }).then((choice) =>
    resolveCloseChoice(choice, {
      save: host.save,
      discard: () => {
        // Typed out-of-range numbers of this rule go too, not back into the reverted row.
        row.querySelectorAll("[aria-invalid='true']").forEach((input) => {
          input.removeAttribute("aria-invalid");
        });
        host.revertRule(ruleId);
      },
      proceed: () => host.collapseRule(ruleId)
    })
  );
  return true;
}
