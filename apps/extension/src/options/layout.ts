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
  /** Second line of the save bar: which sections hold unsaved changes. */
  saveDetail: HTMLElement;
  saveButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  showSection(id: SettingsSectionId): void;
  currentSection(): SettingsSectionId;
  /** Marks sections with unsaved changes in the navigation, their headers and the save bar. */
  setDirtySections(sections: ReadonlySet<SettingsSectionId>): void;
};

/** Section title for messages such as "Unsaved changes in {section}". */
export function sectionTitle(t: Translate, id: SettingsSectionId): string {
  const spec = SETTINGS_SECTIONS.find((section) => section.id === id);
  return spec ? t(spec.title) : id;
}

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
  const navMarks = new Map<SettingsSectionId, HTMLElement>();
  const headerMarks = new Map<SettingsSectionId, HTMLElement>();
  const sections = new Map<SettingsSectionId, HTMLElement>();
  let current: SettingsSectionId = DEFAULT_SECTION;

  for (const spec of SETTINGS_SECTIONS) {
    // The dot is decorative; screen readers get the text next to it.
    const mark = el("span", { className: "wb-settings__nav-dirty" }, [
      el("span", { className: "wb-settings__nav-dot", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "wb-sr-only", text: `(${t("optionsNavUnsaved")})` })
    ]);
    mark.hidden = true;
    navMarks.set(spec.id, mark);
    const link = el(
      "a",
      {
        className: "wb-settings__nav-link",
        attrs: { href: `#${spec.id}` },
        dataset: { sectionLink: spec.id, dirty: "false" }
      },
      [el("span", { className: "wb-settings__nav-text", text: t(spec.title) }), " ", mark]
    );
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
          unsavedLabel: t("optionsUnsavedChanges"),
          ...(spec.resettable ? { resetLabel: t("optionsResetSection") } : {})
        }),
        body
      ]
    );
    const headerMark = section.querySelector<HTMLElement>("[data-section-unsaved]");

    if (headerMark) {
      headerMarks.set(spec.id, headerMark);
    }

    section.hidden = true;
    sections.set(spec.id, section);
    content.append(section);
  }

  const saveState = el("span", {
    className: "wb-savebar__state",
    attrs: { role: "status", "aria-live": "polite" },
    dataset: { saveState: "" }
  });
  const saveDetail = el("span", { className: "wb-savebar__detail", dataset: { saveDetail: "" } });
  const cancelButton = el("button", {
    className: "wb-btn wb-btn--muted wb-btn--large",
    text: t("optionsCancel"),
    attrs: { type: "button", id: "resetConfig" },
    dataset: { action: "settings-cancel" }
  });
  const saveButton = el(
    "button",
    {
      className: "wb-btn wb-btn--brand wb-btn--large wb-savebar__save",
      attrs: { type: "button", id: "saveConfig" },
      dataset: { action: "settings-save" }
    },
    [icon("check"), t("optionsSave")]
  );

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
      [
        el("div", { className: "wb-savebar__inner" }, [
          el("div", { className: "wb-savebar__status" }, [
            el("span", { className: "wb-savebar__dot", attrs: { "aria-hidden": "true" } }),
            el("div", { className: "wb-savebar__text" }, [saveState, saveDetail])
          ]),
          el("div", { className: "wb-savebar__actions" }, [cancelButton, saveButton])
        ])
      ]
    )
  ]);

  const setDirtySections = (dirty: ReadonlySet<SettingsSectionId>): void => {
    for (const spec of SETTINGS_SECTIONS) {
      const isDirty = dirty.has(spec.id);
      links.get(spec.id)?.setAttribute("data-dirty", String(isDirty));
      navMarks.get(spec.id)?.toggleAttribute("hidden", !isDirty);
      headerMarks.get(spec.id)?.toggleAttribute("hidden", !isDirty);
    }

    const names = SETTINGS_SECTIONS.filter((spec) => dirty.has(spec.id)).map((spec) =>
      t(spec.title)
    );
    saveDetail.textContent =
      names.length > 0 ? t("optionsUnsavedIn", { sections: names.join(", ") }) : "";
  };

  const showSection = (id: SettingsSectionId): void => {
    current = id;

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

  return {
    root,
    content,
    bodies,
    saveState,
    saveDetail,
    saveButton,
    cancelButton,
    showSection,
    currentSection: () => current,
    setDirtySections
  };
}
