import type { ExtensionMessageKey } from "../shared/i18n.js";
import { openChoiceDialog, type DialogChoice } from "../shared/ui/dialogs.js";
import {
  isSettingsSectionId,
  sectionFromHash,
  sectionTitle,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsShell
} from "./layout.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

type LeaveChoice = "save" | "discard";

export type SectionLeaveGuardDeps = {
  shell: SettingsShell;
  t: Translate;
  /** Sections holding unsaved changes or invalid input. */
  dirtySections(): ReadonlySet<SettingsSectionId>;
  /** Save is blocked while a field is invalid. */
  canSave(): boolean;
  /** Saves everything; resolves true when nothing is left unsaved. */
  save(): Promise<boolean>;
  discard(): void;
};

/**
 * Switching away from a section with unsaved changes asks first: Save changes, Discard changes
 * or Stay. Navigation clicks and back/forward (hash changes) both go through it.
 */
export function installSectionLeaveGuard(deps: SectionLeaveGuardDeps): void {
  const { shell } = deps;
  let prompting = false;

  const needsPrompt = (target: SettingsSectionId): boolean =>
    target !== shell.currentSection() && deps.dirtySections().has(shell.currentSection());

  const go = (target: SettingsSectionId): void => {
    if (location.hash !== `#${target}`) {
      location.hash = `#${target}`;
    }

    shell.showSection(target);
  };

  const leave = async (target: SettingsSectionId): Promise<void> => {
    if (prompting) {
      return;
    }

    prompting = true;

    try {
      const choice = await askToLeave(deps, shell.currentSection());

      if (choice === "discard") {
        deps.discard();
        go(target);
      } else if (choice === "save" && (await deps.save())) {
        go(target);
      }
    } finally {
      prompting = false;
    }
  };

  shell.root.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
      "[data-section-link]"
    );
    const target = link?.dataset.sectionLink ?? "";
    const plainClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

    if (plainClick && isSettingsSectionId(target) && needsPrompt(target)) {
      event.preventDefault();
      void leave(target);
    }
  });

  window.addEventListener("hashchange", () => {
    // A page instance that was replaced (tests re-import the module) must not react.
    if (!shell.root.isConnected) {
      return;
    }

    const target = sectionFromHash(location.hash);

    if (!needsPrompt(target)) {
      shell.showSection(target);
      return;
    }

    // Back/forward already moved the hash: put it back until the user decides.
    history.replaceState(null, "", `#${shell.currentSection()}`);
    void leave(target);
  });
}

function askToLeave(
  deps: SectionLeaveGuardDeps,
  section: SettingsSectionId
): Promise<LeaveChoice | null> {
  const { t } = deps;
  const dirty = deps.dirtySections();
  const names = SETTINGS_SECTIONS.filter((spec) => dirty.has(spec.id))
    .map((spec) => t(spec.title))
    .join(", ");
  const canSave = deps.canSave();
  const choices: Array<DialogChoice<LeaveChoice>> = [
    {
      value: "discard",
      label: t("optionsDiscardChanges"),
      action: "leave-discard",
      variant: "danger"
    },
    ...(canSave
      ? [
          {
            value: "save" as const,
            label: t("optionsSave"),
            action: "leave-save",
            variant: "brand" as const,
            primary: true
          }
        ]
      : [])
  ];

  return openChoiceDialog<LeaveChoice>({
    title: t("optionsLeaveTitle", { section: sectionTitle(t, section) }),
    body: t(canSave ? "optionsLeaveBody" : "optionsLeaveBlockedBody", { sections: names }),
    cancelLabel: t("optionsLeaveStay"),
    cancelAction: "leave-stay",
    choices
  });
}
