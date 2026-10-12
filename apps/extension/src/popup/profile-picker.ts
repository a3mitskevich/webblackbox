import type { ExtensionMessageKey } from "../shared/i18n.js";
import type {
  ProfileCancelNotice,
  ProfileCancelReason,
  ProfilePreviewResponse
} from "../shared/messages.js";
import { displayProfileName } from "../shared/profiles/display-name.js";
import { el } from "../shared/ui/dom.js";
import { icon } from "../shared/ui/icons.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

/**
 * "Profile: Maximum · Change": what Record uses (picked by a site rule or the default profile),
 * and the way to the profiles in Options. The choice itself lives there.
 */
export function createProfileLine(
  preview: ProfilePreviewResponse | undefined,
  t: Translate
): HTMLElement {
  const selection = preview?.selection;
  const name = selection ? displayProfileName(selection, t) : "…";
  const ruled =
    selection?.source === "rule" && selection.ruleName
      ? t("popupProfileLineRule", { rule: selection.ruleName })
      : "";
  const capped = selection?.enterpriseCapped?.length
    ? [
        el("span", {
          className: "wb-popup__profile-capped",
          text: t("popupProfileEnterpriseCapped", {
            categories: selection.enterpriseCapped.join(", ")
          })
        })
      ]
    : [];

  return el("p", { className: "wb-popup__profile-line", dataset: { profileLine: "" } }, [
    el("span", { text: t("popupProfileLineLabel") }),
    " ",
    el("strong", { text: name, dataset: { profileName: selection?.id ?? "" } }),
    ...(ruled ? [" ", el("span", { className: "wb-popup__hint", text: ruled })] : []),
    " · ",
    el("button", {
      className: "wb-link-btn",
      text: t("popupProfileChange"),
      attrs: { type: "button" },
      dataset: { action: "open-profiles" }
    }),
    ...capped
  ]);
}

/** The service worker answered and no profile exists: recording needs one first. */
export function hasNoRecordingProfiles(preview: ProfilePreviewResponse | undefined): boolean {
  return preview !== undefined && preview.catalog.length === 0;
}

/**
 * "No recording profile" panel in the Start panel's place: what is missing and one way on, to
 * the profiles section of Options.
 */
export function createProfileRequirementSection(t: Translate): HTMLElement {
  return el(
    "section",
    {
      className: "wb-panel wb-popup__start wb-popup__profile-required",
      attrs: { role: "alert" },
      dataset: { profileRequired: "" }
    },
    [
      el("h2", { className: "wb-panel__title", text: t("popupProfileRequiredTitle") }),
      el("p", { className: "wb-popup__hint", text: t("popupProfileRequired") }),
      el(
        "button",
        {
          className: "wb-btn wb-btn--brand wb-btn--block",
          attrs: { type: "button" },
          dataset: { action: "open-profiles" }
        },
        [icon("settings"), t("popupOpenProfiles")]
      )
    ]
  );
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
  section.className = "wb-popup__alert wb-popup__profile-cancel";
  section.dataset.profileCancel = "";
  section.setAttribute("role", "alert");

  const dismiss = createButton(t("popupProfileCancelDismiss"), "ack-profile-cancel");
  dismiss.dataset.sid = session.sid;

  const actions = document.createElement("div");
  actions.className = "wb-popup__row";
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
