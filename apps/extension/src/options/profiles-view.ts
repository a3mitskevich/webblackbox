import type { ExtensionMessageKey } from "../shared/i18n.js";
import { CAPTURE_CATEGORY_KEYS, type CaptureCategoryKey } from "../shared/profiles/categories.js";
import {
  DEFAULT_PROFILE_ID,
  isReadOnlyProfileId,
  type RecordingProfile
} from "../shared/profiles/model.js";
import { isExtendedCaptureProfile } from "../shared/profiles/resolve.js";
import type { ProfilesDiff } from "../shared/profiles/transfer.js";
import type { RedactionSandboxKind } from "../shared/redaction-sandbox.js";
import { button, el } from "./dom.js";
import { fieldGroup, selectField } from "./fields.js";
import { categoryLabel, levelLabel } from "./profile-form.js";

/** Renderers for the profile list, the redaction sandbox and profiles import/export. */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

export const SANDBOX_KINDS: Array<{ value: RedactionSandboxKind; key: ExtensionMessageKey }> = [
  { value: "body", key: "optionsSandboxKindBody" },
  { value: "event", key: "optionsSandboxKindEvent" },
  { value: "headers", key: "optionsSandboxKindHeaders" },
  { value: "url", key: "optionsSandboxKindUrl" }
];

/** Categories worth a glance on a collapsed profile card. */
const CARD_CATEGORIES: readonly CaptureCategoryKey[] = ["inputs", "console", "network", "dom"];

export function createProfileCard(options: {
  profile: RecordingProfile;
  defaultProfileId: string;
  editing: boolean;
  t: Translate;
}): HTMLElement {
  const { profile, t } = options;
  const readOnly = isReadOnlyProfileId(profile.id);
  const isDefault = profile.id === options.defaultProfileId;
  const badges = [
    isDefault ? t("optionsProfileDefaultBadge") : "",
    readOnly ? t("optionsProfileReadOnlyBadge") : "",
    isExtendedCaptureProfile(profile) ? t("optionsProfileExtendedBadge") : ""
  ].filter(Boolean);
  const actions = el("div", { className: "wb-profile-card__actions" });

  if (!readOnly) {
    actions.append(button(t("optionsProfileEdit"), "profile-edit", "surface", { small: true }));
  }

  actions.append(
    button(t("optionsProfileDuplicate"), "profile-duplicate", "ghost", { small: true })
  );

  if (!isDefault) {
    actions.append(
      button(t("optionsProfileMakeDefault"), "profile-default", "ghost", { small: true })
    );
  }

  if (!readOnly && profile.id !== DEFAULT_PROFILE_ID) {
    actions.append(button(t("optionsProfileDelete"), "profile-delete", "ghost", { small: true }));
  }

  const levels = CAPTURE_CATEGORY_KEYS.filter((key) => CARD_CATEGORIES.includes(key)).map(
    (key) => `${categoryLabel(t, key)}: ${levelLabel(t, profile.categories[key])}`
  );

  return el(
    "li",
    {
      className: options.editing
        ? "wb-profile-card wb-profile-card--editing wb-profiles__row"
        : "wb-profile-card wb-profiles__row",
      dataset: { profileId: profile.id }
    },
    [
      el("div", { className: "wb-profile-card__head" }, [
        el("strong", { className: "wb-profile-card__name", text: profile.name }),
        el("span", {
          className: "wb-profile-card__mode",
          text: profile.base === "full" ? t("modeFull") : t("modeLite")
        })
      ]),
      ...(badges.length > 0
        ? [el("span", { className: "wb-profile-card__badges", text: badges.join(" · ") })]
        : []),
      el("details", { className: "wb-profile-card__about" }, [
        el("summary", { text: t("optionsProfileAbout") }),
        ...(profile.description
          ? [el("p", { className: "wb-field__hint", text: profile.description })]
          : []),
        el("p", { className: "wb-profile-card__levels", text: levels.join(" · ") })
      ]),
      actions
    ]
  );
}

export function createSandboxPanel(options: {
  catalog: readonly RecordingProfile[];
  sandbox: { profileId: string; kind: RedactionSandboxKind; text: string; output?: string };
  t: Translate;
}): HTMLElement {
  const { t } = options;
  const input = el("textarea", {
    className: "wb-textarea",
    attrs: {
      id: "sandbox-input",
      name: "sandboxInput",
      rows: "6",
      spellcheck: "false",
      placeholder: '{"email":"qa@example.com","password":"hunter2"}'
    }
  });
  input.value = options.sandbox.text;

  return el("div", { className: "wb-sandbox wb-profiles__sandbox" }, [
    el("h3", { className: "wb-group__title", text: t("optionsSandboxTitle") }),
    el("p", { className: "wb-field__hint", text: t("optionsSandboxHint") }),
    fieldGroup(null, [
      selectField({
        id: "sandbox-profile",
        name: "sandboxProfile",
        label: t("optionsRuleProfile"),
        value: options.sandbox.profileId,
        options: options.catalog.map((profile) => ({ value: profile.id, label: profile.name }))
      }),
      selectField({
        id: "sandbox-kind",
        name: "sandboxKind",
        label: t("optionsSandboxKind"),
        value: options.sandbox.kind,
        options: SANDBOX_KINDS.map((kind) => ({ value: kind.value, label: t(kind.key) }))
      })
    ]),
    el("div", { className: "wb-sandbox__panes" }, [
      el("div", { className: "wb-field wb-field--wide" }, [
        el("label", {
          className: "wb-field__label",
          text: t("optionsSandboxInput"),
          attrs: { for: "sandbox-input" }
        }),
        input
      ]),
      el("div", { className: "wb-field wb-field--wide" }, [
        el("span", { className: "wb-field__label", text: t("optionsSandboxOutput") }),
        el("pre", {
          className: "wb-sandbox__output wb-profiles__sandbox-output",
          text: options.sandbox.output ?? "",
          attrs: { "aria-live": "polite" },
          dataset: { sandboxOutput: "" }
        })
      ])
    ]),
    el("div", { className: "wb-actions" }, [
      button(t("optionsSandboxRun"), "sandbox-run", "brand", { small: true })
    ])
  ]);
}

export function createTransferPanel(options: {
  importPreview?: { diff: ProfilesDiff };
  t: Translate;
}): HTMLElement {
  const { t } = options;
  const fileInput = el("input", {
    className: "wb-sr-only",
    attrs: {
      type: "file",
      id: "profiles-import-file",
      accept: "application/json,.json",
      name: "profilesImport"
    }
  });
  const panel = el("div", { className: "wb-transfer wb-profiles__transfer" }, [
    el("div", { className: "wb-transfer__card" }, [
      el("h3", { className: "wb-group__title", text: t("optionsProfilesExport") }),
      el("p", { className: "wb-field__hint", text: t("optionsProfilesExportHint") }),
      el("div", { className: "wb-actions" }, [
        button(t("optionsProfilesExport"), "profiles-export", "surface", {
          small: true,
          iconName: "download"
        })
      ])
    ]),
    el("div", { className: "wb-transfer__card" }, [
      el("h3", { className: "wb-group__title", text: t("optionsProfilesImport") }),
      el("p", { className: "wb-field__hint", text: t("optionsProfilesImportHint") }),
      el("div", { className: "wb-actions" }, [
        el(
          "label",
          {
            className: "wb-btn wb-btn--surface wb-btn--small wb-file-button",
            attrs: { for: "profiles-import-file" }
          },
          [t("optionsProfilesImportChoose")]
        ),
        fileInput
      ])
    ])
  ]);

  if (options.importPreview) {
    panel.append(createImportPreview(options.importPreview.diff, t));
  }

  return panel;
}

function createImportPreview(diff: ProfilesDiff, t: Translate): HTMLElement {
  return el(
    "div",
    {
      className: "wb-transfer__preview",
      attrs: { role: "region", "aria-label": t("optionsProfilesImportPreview") }
    },
    [
      el("p", {
        className: "wb-transfer__summary",
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
        el("p", { className: "wb-field__hint", dataset: { importDetail: "" }, text })
      ),
      el("div", { className: "wb-actions" }, [
        button(t("optionsProfilesImportApply"), "profiles-import-apply", "accent", {
          small: true
        })
      ])
    ]
  );
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
