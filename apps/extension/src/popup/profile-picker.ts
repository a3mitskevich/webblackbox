import type { CaptureMode } from "@webblackbox/protocol";

import type { ExtensionMessageKey } from "../shared/i18n.js";
import type {
  ProfileCancelNotice,
  ProfileCancelReason,
  ProfilePreviewResponse
} from "../shared/messages.js";

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
  const headline =
    selection.source === "rule" && selection.ruleName
      ? t("popupProfileByRule", { name: selection.name, rule: selection.ruleName })
      : t("popupProfileWillUse", { name: selection.name });
  const capped = selection.enterpriseCapped?.length
    ? [t("popupProfileEnterpriseCapped", { categories: selection.enterpriseCapped.join(", ") })]
    : [];

  return [
    headline,
    ...capped,
    t("popupProfileRecommends", { mode: options.formatMode(selection.base) })
  ].join(" ");
}

/** The service worker answered and no profile exists: recording needs one first. */
export function hasNoRecordingProfiles(preview: ProfilePreviewResponse | undefined): boolean {
  return preview !== undefined && preview.catalog.length === 0;
}

/** "No recording profile" block with a button to the profiles section of Options. */
export function createProfileRequirementSection(t: Translate): HTMLElement {
  const section = document.createElement("section");
  section.className = "wb-popup__policy wb-popup__profile-required";
  section.dataset.profileRequired = "";
  section.setAttribute("role", "alert");
  section.append(
    createText("strong", t("popupProfileRequiredTitle")),
    createText("p", t("popupProfileRequired")),
    createButton(t("popupOpenProfiles"), "open-profiles")
  );
  return section;
}

const CANCEL_TEXT_KEYS: Record<
  ProfileCancelReason,
  { summary: ExtensionMessageKey; fix: ExtensionMessageKey }
> = {
  "rule-changed": {
    summary: "popupProfileCancelRuleChanged",
    fix: "popupProfileCancelRuleChangedFix"
  },
  "profile-missing": {
    summary: "popupProfileCancelMissing",
    fix: "popupProfileCancelMissingFix"
  },
  "profile-edited": {
    summary: "popupProfileCancelEdited",
    fix: "popupProfileCancelEditedFix"
  },
  "enterprise-policy": {
    summary: "popupProfileCancelPolicy",
    fix: "popupProfileCancelPolicyFix"
  }
};

/** What changed and how to fix it, for a recording stopped by a profile change. */
export function describeProfileCancel(
  notice: ProfileCancelNotice,
  t: Translate
): { summary: string; fix: string } {
  const keys = CANCEL_TEXT_KEYS[notice.reason];
  const vars = {
    started: notice.startedName,
    next: notice.nextName ?? t("popupProfileCancelAnotherProfile")
  };

  return { summary: t(keys.summary, vars), fix: t(keys.fix, vars) };
}

/** Alert for a session the service worker stopped because its profile changed. */
export function createProfileCancelSection(
  session: { sid: string; profileCancel: ProfileCancelNotice },
  t: Translate
): HTMLElement {
  const { summary, fix } = describeProfileCancel(session.profileCancel, t);
  const section = document.createElement("section");
  section.className = "wb-popup__policy wb-popup__profile-cancel";
  section.dataset.profileCancel = "";
  section.setAttribute("role", "alert");

  const dismiss = createButton(t("popupProfileCancelDismiss"), "ack-profile-cancel");
  dismiss.dataset.sid = session.sid;

  const actions = document.createElement("div");
  actions.className = "wb-popup__nav";
  actions.append(createButton(t("popupOpenProfiles"), "open-profiles"), dismiss);

  section.append(
    createText("strong", t("popupProfileCancelTitle")),
    createText("p", summary),
    createText("p", fix),
    createText("p", t("popupProfileCancelKept")),
    actions
  );
  return section;
}

function createText(tag: "strong" | "p", text: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function createButton(label: string, action: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wb-btn wb-btn--surface";
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function createOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}
