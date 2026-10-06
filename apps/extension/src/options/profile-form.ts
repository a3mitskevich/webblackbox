import type { ExtensionMessageKey } from "../shared/i18n.js";
import { resolveLocalDataSettings } from "../shared/profiles/local-data.js";
import {
  CAPTURE_CATEGORY_KEYS,
  CAPTURE_CATEGORY_LEVELS,
  type CaptureCategoryKey
} from "../shared/profiles/categories.js";
import {
  MAX_BODY_CAPTURE_BYTES,
  MAX_LIST_ENTRIES,
  MAX_MOUSEMOVE_HZ,
  MAX_PATTERN_LENGTH,
  MAX_SOURCE_MAP_BYTES,
  MAX_UNEXPORTED_RETENTION_MINUTES,
  MIN_UNEXPORTED_RETENTION_MINUTES,
  type RecordingProfile
} from "../shared/profiles/model.js";
import { button, el } from "./dom.js";
import { formatValuePatternLines } from "./profile-form-model.js";
import {
  chipListField,
  fieldGroup,
  isValidHeaderName,
  isValidMimeType,
  isValidSelector,
  numberField,
  selectField,
  textField,
  toggleField
} from "./fields.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

const CATEGORY_LABELS: Record<CaptureCategoryKey, ExtensionMessageKey> = {
  actions: "optionsCategoryActions",
  inputs: "optionsCategoryInputs",
  dom: "optionsCategoryDom",
  screenshots: "optionsCategoryScreenshots",
  screenRecordings: "optionsCategoryScreenRecordings",
  console: "optionsCategoryConsole",
  network: "optionsCategoryNetwork",
  storage: "optionsCategoryStorage",
  indexedDb: "optionsCategoryIndexedDb",
  cookies: "optionsCategoryCookies",
  cdp: "optionsCategoryCdp",
  heapProfiles: "optionsCategoryHeapProfiles",
  tabsContext: "optionsCategoryTabsContext"
};

const LEVEL_LABELS: Record<string, ExtensionMessageKey> = {
  off: "optionsLevelOff",
  none: "optionsLevelNone",
  metadata: "optionsLevelMetadata",
  masked: "optionsLevelMasked",
  allow: "optionsLevelAllow",
  "length-only": "optionsLevelLengthOnly",
  wireframe: "optionsLevelWireframe",
  sanitized: "optionsLevelSanitized",
  "headers-allowlist": "optionsLevelHeadersAllowlist",
  "body-allowlist": "optionsLevelBodyAllowlist",
  "counts-only": "optionsLevelCountsOnly",
  "count-only": "optionsLevelCountsOnly",
  "names-only": "optionsLevelNamesOnly",
  "lengths-only": "optionsLevelLengthsOnly",
  "safe-subset": "optionsLevelSafeSubset",
  full: "optionsLevelFull",
  "lab-only": "optionsLevelLabOnly"
};

export function categoryLabel(t: Translate, key: CaptureCategoryKey): string {
  return t(CATEGORY_LABELS[key]);
}

export function levelLabel(t: Translate, level: string): string {
  const key = LEVEL_LABELS[level];
  return key ? t(key) : level;
}

/** How revealing a level is within its category, for colour: low, mid or high. */
function levelTone(index: number, count: number): "low" | "mid" | "high" {
  if (index === 0) {
    return "low";
  }

  return index === count - 1 ? "high" : "mid";
}

/** Category × level radio matrix; each row is one radio group named `category-<key>`. */
export function createCategoryMatrix(profile: RecordingProfile, t: Translate): HTMLElement {
  const rows = CAPTURE_CATEGORY_KEYS.map((key) => {
    const levels = CAPTURE_CATEGORY_LEVELS[key] as readonly string[];
    const label = categoryLabel(t, key);
    const group = el("div", {
      className: "wb-matrix__levels",
      attrs: { role: "radiogroup", "aria-label": label }
    });

    levels.forEach((level, index) => {
      const input = el("input", {
        className: "wb-matrix__input",
        attrs: { type: "radio", name: `category-${key}`, value: level }
      });
      input.checked = profile.categories[key] === level;
      group.append(
        el(
          "label",
          {
            className: "wb-matrix__level",
            dataset: { tone: levelTone(index, levels.length) },
            attrs: { title: level }
          },
          [input, el("span", { text: levelLabel(t, level) })]
        )
      );
    });

    return el("tr", {}, [
      el("th", { text: label, attrs: { scope: "row" } }),
      el("td", {}, [group])
    ]);
  });

  return el("fieldset", { className: "wb-matrix" }, [
    el("legend", { className: "wb-group__title", text: t("optionsProfileCategories") }),
    el("p", { className: "wb-field__hint", text: t("optionsProfileCategoriesHint") }),
    el("table", { className: "wb-matrix__table" }, [el("tbody", {}, rows)])
  ]);
}

function listOptions(t: Translate) {
  return {
    removeLabel: (value: string) => t("optionsChipRemove", { value }),
    duplicateMessage: t("optionsChipDuplicate"),
    maxItems: MAX_LIST_ENTRIES,
    tooManyMessage: t("optionsChipTooMany", { max: MAX_LIST_ENTRIES })
  };
}

export function selectorValidator(t: Translate): (value: string) => string | null {
  return (value) =>
    value.length > MAX_PATTERN_LENGTH
      ? t("optionsErrorTooLong", { max: MAX_PATTERN_LENGTH })
      : isValidSelector(value)
        ? null
        : t("optionsErrorSelector");
}

export function headerValidator(t: Translate): (value: string) => string | null {
  return (value) => (isValidHeaderName(value) ? null : t("optionsErrorHeader"));
}

export function patternValidator(t: Translate): (value: string) => string | null {
  return (value) =>
    value.length > MAX_PATTERN_LENGTH
      ? t("optionsErrorTooLong", { max: MAX_PATTERN_LENGTH })
      : null;
}

export function chipListOptions(t: Translate) {
  return listOptions(t);
}

/** Form for one editable profile; values are read back by name in profiles-editor. */
export function createProfileForm(profile: RecordingProfile, t: Translate): HTMLElement {
  const list = listOptions(t);
  const localData = resolveLocalDataSettings(profile);
  const chips = (
    name: string,
    label: ExtensionMessageKey,
    values: readonly string[],
    placeholder: ExtensionMessageKey,
    validate: (value: string) => string | null,
    hint?: ExtensionMessageKey
  ): HTMLElement =>
    chipListField({
      ...list,
      id: `pf-${name}`,
      name,
      label: t(label),
      ...(hint ? { hint: t(hint) } : {}),
      values,
      placeholder: t(placeholder),
      validate
    });

  return el(
    "form",
    {
      className: "wb-profile-form wb-profiles__form",
      attrs: { "aria-labelledby": "pf-title", novalidate: "" },
      dataset: { profileForm: profile.id }
    },
    [
      el("div", { className: "wb-profile-form__head" }, [
        el("h3", {
          className: "wb-profile-form__title",
          text: t("optionsProfileEditing", { name: profile.name }),
          attrs: { id: "pf-title" }
        }),
        el("div", { className: "wb-profile-form__actions" }, [
          button(t("optionsProfileCancel"), "profile-cancel", "muted", { small: true }),
          button(t("optionsProfileSave"), "profile-apply", "brand", { small: true })
        ])
      ]),
      fieldGroup(null, [
        textField({
          id: "pf-name",
          name: "name",
          label: t("optionsProfileName"),
          value: profile.name
        }),
        selectField({
          id: "pf-base",
          name: "base",
          label: t("optionsProfileBase"),
          help: t("optionsProfileBaseHelp"),
          helpLabel: t("optionsHelpAbout", { label: t("optionsProfileBase") }),
          value: profile.base,
          options: [
            { value: "lite", label: t("modeLite") },
            { value: "full", label: t("modeFull") }
          ]
        }),
        selectField({
          id: "pf-visual",
          name: "visual",
          label: t("optionsProfileVisual"),
          value: profile.visual ?? "",
          options: [
            { value: "", label: t("optionsProfileVisualPopup") },
            { value: "screenshots", label: t("popupFullVisualScreenshots") },
            { value: "recording", label: t("popupVisualVideo") },
            { value: "both", label: t("popupFullVisualBoth") },
            { value: "none", label: t("popupFullVisualNone") }
          ]
        }),
        selectField({
          id: "pf-sourceMaps",
          name: "sourceMaps",
          label: t("optionsProfileSourceMaps"),
          value: profile.sourceMaps?.mode ?? "",
          options: [
            { value: "", label: t("optionsProfileSourceMapsAuto") },
            { value: "off", label: t("optionsProfileSourceMapsOff") },
            { value: "metadata", label: t("optionsProfileSourceMapsMetadata") },
            { value: "embed", label: t("optionsProfileSourceMapsEmbed") }
          ]
        }),
        numberField({
          id: "pf-sourceMapMaxBytes",
          name: "sourceMapMaxBytes",
          label: t("optionsProfileSourceMapMaxBytes"),
          value: profile.sourceMaps?.maxMapBytes?.toString() ?? "",
          min: 1,
          max: MAX_SOURCE_MAP_BYTES,
          step: 1024,
          unit: "B"
        })
      ]),
      createCategoryMatrix(profile, t),
      fieldGroup(
        t("optionsProfileGroupMasking"),
        [
          toggleField({
            id: "pf-contentRedaction",
            name: "contentRedaction",
            label: t("optionsProfileContentRedaction"),
            checked: profile.redaction.contentRedaction !== false
          }),
          toggleField({
            id: "pf-builtInHeuristics",
            name: "builtInHeuristics",
            label: t("optionsProfileBuiltInHeuristics"),
            checked: profile.redaction.builtInHeuristics !== false
          }),
          chips(
            "blockedSelectors",
            "optionsBlockedSelectors",
            profile.redaction.blockedSelectors,
            "optionsSelectorPlaceholder",
            selectorValidator(t)
          ),
          chips(
            "unmaskSelectors",
            "optionsProfileUnmaskSelectors",
            profile.unmaskSelectors,
            "optionsSelectorPlaceholder",
            selectorValidator(t),
            "optionsProfileUnmaskHint"
          ),
          chips(
            "redactHeaders",
            "optionsRedactedHeaders",
            profile.redaction.redactHeaders,
            "optionsHeaderPlaceholder",
            headerValidator(t)
          ),
          chips(
            "redactCookieNames",
            "optionsProfileRedactCookieNames",
            profile.redaction.redactCookieNames,
            "optionsCookieNamePlaceholder",
            patternValidator(t)
          ),
          chips(
            "redactBodyPatterns",
            "optionsBodySensitivePatterns",
            profile.redaction.redactBodyPatterns,
            "optionsPatternPlaceholder",
            patternValidator(t)
          ),
          chips(
            "redactQueryParams",
            "optionsProfileRedactQueryParams",
            profile.redaction.redactQueryParams ?? [],
            "optionsQueryParamPlaceholder",
            patternValidator(t)
          ),
          chips(
            "redactStorageKeys",
            "optionsProfileRedactStorageKeys",
            profile.redaction.redactStorageKeys ?? [],
            "optionsStorageKeyPlaceholder",
            patternValidator(t)
          ),
          chips(
            "valuePatterns",
            "optionsProfileValuePatterns",
            // One chip per rule: `[bodies, console] regex`, or just `regex` for every target.
            (profile.redaction.valuePatterns ?? []).map((rule) => formatValuePatternLines([rule])),
            "optionsValuePatternPlaceholder",
            patternValidator(t)
          )
        ],
        t("optionsRedactionDisclaimer")
      ),
      fieldGroup(t("optionsProfileGroupBodies"), [
        numberField({
          id: "pf-bodyMaxBytes",
          name: "bodyMaxBytes",
          label: t("optionsProfileBodyMaxBytes"),
          hint: t("optionsInheritHint"),
          value: profile.network.bodyMaxBytes?.toString() ?? "",
          min: 0,
          max: MAX_BODY_CAPTURE_BYTES,
          step: 1024,
          unit: "B"
        }),
        numberField({
          id: "pf-mousemoveHz",
          name: "mousemoveHz",
          label: t("optionsProfileMousemoveHz"),
          hint: t("optionsInheritHint"),
          value: profile.pointer.mousemoveHz?.toString() ?? "",
          min: 1,
          max: MAX_MOUSEMOVE_HZ,
          unit: "Hz"
        }),
        chips(
          "bodyMimeAllowlist",
          "optionsProfileBodyMimeAllowlist",
          profile.network.bodyMimeAllowlist,
          "optionsMimePlaceholder",
          (value) => (isValidMimeType(value) ? null : t("optionsErrorMime")),
          "optionsProfileBodyMimeHint"
        ),
        chips(
          "includeUrls",
          "optionsProfileIncludeUrls",
          profile.network.includeUrls,
          "optionsUrlGlobPlaceholder",
          patternValidator(t)
        ),
        chips(
          "excludeUrls",
          "optionsProfileExcludeUrls",
          profile.network.excludeUrls,
          "optionsUrlGlobPlaceholder",
          patternValidator(t)
        )
      ]),
      fieldGroup(t("optionsProfileGroupLocalData"), [
        toggleField({
          id: "pf-deleteAfterExport",
          name: "deleteAfterExport",
          label: t("optionsProfileDeleteAfterExport"),
          hint: t("localDataRestartNotice"),
          checked: localData.deleteAfterExport
        }),
        numberField({
          id: "pf-unexportedRetentionMinutes",
          name: "unexportedRetentionMinutes",
          label: t("optionsProfileUnexportedRetention"),
          value: String(localData.unexportedRetentionMinutes),
          min: MIN_UNEXPORTED_RETENTION_MINUTES,
          max: MAX_UNEXPORTED_RETENTION_MINUTES,
          unit: "min"
        })
      ])
    ]
  );
}
