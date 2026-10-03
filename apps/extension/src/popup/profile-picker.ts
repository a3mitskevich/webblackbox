import type { CaptureMode } from "@webblackbox/protocol";

import type { ExtensionMessageKey } from "../shared/i18n.js";
import type { ProfilePreviewResponse } from "../shared/messages.js";

/** Popup choice meaning "let the site rules pick the profile". */
export const PROFILE_CHOICE_AUTO = "auto";

const PROFILE_CHOICE_STORAGE_KEY = "webblackbox.popup.profile-choice";
const MAX_PROFILE_CHOICE_LENGTH = 100;

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type ProfilePickerOptions = {
  preview: ProfilePreviewResponse | undefined;
  choice: string;
  disabled: boolean;
  t: Translate;
  formatMode: (mode: CaptureMode) => string;
};

export function loadProfileChoice(): string {
  try {
    const raw = globalThis.localStorage?.getItem(PROFILE_CHOICE_STORAGE_KEY);
    return raw && raw.length <= MAX_PROFILE_CHOICE_LENGTH ? raw : PROFILE_CHOICE_AUTO;
  } catch {
    return PROFILE_CHOICE_AUTO;
  }
}

export function saveProfileChoice(value: string): void {
  try {
    globalThis.localStorage?.setItem(PROFILE_CHOICE_STORAGE_KEY, value);
  } catch {
    // ignore storage write failures
  }
}

/** `profileId` to send with `ui.start`, or nothing for automatic selection. */
export function toStartProfileId(choice: string): string | undefined {
  return choice === PROFILE_CHOICE_AUTO ? undefined : choice;
}

/** Profile select plus a one-line explanation of what Start will record with. */
export function createProfilePickerSection(options: ProfilePickerOptions): HTMLElement {
  const { preview, t } = options;
  const section = document.createElement("section");
  section.className = "wb-popup__policy wb-popup__profile";

  const label = document.createElement("label");
  label.className = "wb-popup__policy-title";
  label.htmlFor = "wb-profile-select";
  label.textContent = t("popupProfileTitle");

  const select = document.createElement("select");
  select.id = "wb-profile-select";
  select.dataset.profileSelect = "";
  select.disabled = options.disabled;
  select.append(createOption(PROFILE_CHOICE_AUTO, t("popupProfileAuto")));

  for (const entry of preview?.catalog ?? []) {
    const suffix = entry.extended ? ` · ${t("popupProfileExtended")}` : "";
    select.append(createOption(entry.id, `${entry.name}${suffix}`));
  }

  const knownChoice = [...select.options].some((option) => option.value === options.choice);
  select.value = knownChoice ? options.choice : PROFILE_CHOICE_AUTO;

  const hint = document.createElement("p");
  hint.className = "wb-popup__hint";
  hint.dataset.profileHint = "";
  hint.textContent = describeProfileSelection(options);

  section.append(label, select, hint);
  return section;
}

export function describeProfileSelection(
  options: Pick<ProfilePickerOptions, "preview" | "t" | "formatMode">
): string {
  const selection = options.preview?.selection;

  if (!selection) {
    return "";
  }

  const { t } = options;
  const headline = selection.downgradedFrom
    ? t("popupProfileDowngraded", { requested: selection.downgradedFrom, name: selection.name })
    : selection.source === "rule" && selection.ruleName
      ? t("popupProfileByRule", { name: selection.name, rule: selection.ruleName })
      : t("popupProfileWillUse", { name: selection.name });

  return `${headline} ${t("popupProfileRecommends", { mode: options.formatMode(selection.base) })}`;
}

function createOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}
