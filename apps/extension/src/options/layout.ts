import type { ExtensionMessageKey } from "../shared/i18n.js";
import { el } from "../shared/ui/dom.js";
import { icon } from "../shared/ui/icons.js";
import { sectionHeader } from "./fields.js";
import type { GeneralSectionId } from "./general-model.js";

/**
 * Settings page shell: top bar, section navigation (side list on wide screens, scrolling tabs on
 * narrow ones), one visible section at a time driven by the URL hash, and a sticky save bar.
 */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export type SettingsSectionId = "profiles" | "rules" | GeneralSectionId | "language" | "transfer";

type SectionSpec = {
  id: SettingsSectionId;
  title: ExtensionMessageKey;
  hint: ExtensionMessageKey;
  /** Shows "Reset section" (general sections only). */
  resettable?: boolean;
};

export const SETTINGS_SECTIONS: readonly SectionSpec[] = [
  { id: "profiles", title: "optionsNavProfiles", hint: "optionsProfilesHint" },
  { id: "rules", title: "optionsNavRules", hint: "optionsRulesHint" },
  {
    id: "sensitivity",
    title: "optionsNavSensitivity",
    hint: "optionsSensitivityHint",
    resettable: true
  },
  { id: "pointer", title: "optionsNavPointer", hint: "optionsPointerHint", resettable: true },
  { id: "sampling", title: "optionsNavSampling", hint: "optionsSamplingHint", resettable: true },
  { id: "budgets", title: "optionsNavBudgets", hint: "optionsBudgetsHint", resettable: true },
  { id: "export", title: "optionsNavExport", hint: "optionsExportHint", resettable: true },
  { id: "language", title: "optionsNavLanguage", hint: "optionsLanguageHint" },
  { id: "transfer", title: "optionsNavTransfer", hint: "optionsTransferHint" }
];

export const DEFAULT_SECTION: SettingsSectionId = "profiles";

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** Section named by the URL hash, or the default one. */
export function sectionFromHash(hash: string): SettingsSectionId {
  const id = hash.replace(/^#/, "");
  return isSettingsSectionId(id) ? id : DEFAULT_SECTION;
}

export type SettingsShell = {
  root: HTMLElement;
  /** Element holding every section; the profiles editor binds its events here. */
  content: HTMLElement;
  bodies: Record<SettingsSectionId, HTMLElement>;
  saveState: HTMLElement;
  saveButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  showSection(id: SettingsSectionId): void;
};

function createTopBar(t: Translate, version: string): HTMLElement {
  return el("header", { className: "wb-page-topbar" }, [
    el("div", { className: "wb-brand-lockup" }, [
      el("img", {
        className: "wb-brand-lockup__icon",
        attrs: { src: "./icon/32.png", alt: "", width: "28", height: "28" }
      }),
      el("div", { className: "wb-brand-lockup__copy" }, [
        el("p", { className: "wb-brand-lockup__eyebrow", text: t("brandEyebrowChromeExtension") }),
        el("h1", { className: "wb-brand-lockup__title wb-options-title", text: t("optionsTitle") })
      ])
    ]),
    el("div", { className: "wb-page-topbar__aside" }, [
      el("span", { className: "mono", text: `v${version}` }),
      el(
        "a",
        { className: "wb-btn wb-btn--ghost wb-btn--small", attrs: { href: "./sessions.html" } },
        [icon("sessions"), t("popupSessions")]
      )
    ])
  ]);
}

export function createSettingsShell(t: Translate, version: string): SettingsShell {
  const nav = el("ul", { className: "wb-settings__nav-list" });
  const content = el("div", { className: "wb-settings__content" });
  const bodies = {} as Record<SettingsSectionId, HTMLElement>;
  const links = new Map<SettingsSectionId, HTMLAnchorElement>();
  const sections = new Map<SettingsSectionId, HTMLElement>();

  for (const spec of SETTINGS_SECTIONS) {
    const link = el("a", {
      className: "wb-settings__nav-link",
      text: t(spec.title),
      attrs: { href: `#${spec.id}` },
      dataset: { sectionLink: spec.id }
    });
    links.set(spec.id, link);
    nav.append(el("li", {}, [link]));

    const body = el("div", { className: "wb-section__body" });
    bodies[spec.id] = body;
    const section = el(
      "section",
      {
        className: "wb-section",
        attrs: { id: `section-${spec.id}`, "aria-labelledby": `${spec.id}-title` },
        dataset: { optionsSection: spec.id }
      },
      [
        sectionHeader({
          id: spec.id,
          title: t(spec.title),
          hint: t(spec.hint),
          ...(spec.resettable ? { resetLabel: t("optionsResetSection") } : {})
        }),
        body
      ]
    );
    section.hidden = true;
    sections.set(spec.id, section);
    content.append(section);
  }

  const saveState = el("span", {
    className: "wb-savebar__state",
    attrs: { role: "status", "aria-live": "polite" },
    dataset: { saveState: "" }
  });
  const cancelButton = el("button", {
    className: "wb-btn wb-btn--muted",
    text: t("optionsCancel"),
    attrs: { type: "button", id: "resetConfig" },
    dataset: { action: "settings-cancel" }
  });
  const saveButton = el("button", {
    className: "wb-btn wb-btn--brand",
    text: t("optionsSave"),
    attrs: { type: "button", id: "saveConfig" },
    dataset: { action: "settings-save" }
  });

  const root = el("div", { className: "wb-settings" }, [
    createTopBar(t, version),
    el("div", { className: "wb-settings__body" }, [
      el("nav", { className: "wb-settings__nav", attrs: { "aria-label": t("optionsNavLabel") } }, [
        nav
      ]),
      content
    ]),
    el(
      "div",
      {
        className: "wb-savebar",
        attrs: { role: "region", "aria-label": t("optionsSaveBarLabel") }
      },
      [el("div", { className: "wb-savebar__inner" }, [saveState, cancelButton, saveButton])]
    )
  ]);

  const showSection = (id: SettingsSectionId): void => {
    for (const [sectionId, section] of sections) {
      section.hidden = sectionId !== id;
      const link = links.get(sectionId);

      if (sectionId === id) {
        link?.setAttribute("aria-current", "page");
      } else {
        link?.removeAttribute("aria-current");
      }
    }
  };

  return { root, content, bodies, saveState, saveButton, cancelButton, showSection };
}
