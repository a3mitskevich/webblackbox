import { EXTENSION_UNIT_LABEL_KEYS, type ExtensionMessageKey } from "../shared/i18n.js";
import { el } from "../shared/ui/dom.js";
import {
  chipListField,
  fieldGroup,
  numberField,
  setFieldError,
  textField,
  toggleField,
  type FieldText
} from "./fields.js";
import {
  findField,
  validateNumberField,
  type GeneralDraft,
  type GeneralFieldSpec,
  type GeneralSectionId,
  type ListFieldSpec
} from "./general-model.js";
import {
  chipListOptions,
  headerValidator,
  patternValidator,
  selectorValidator
} from "./profile-form.js";

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

/** Field ids per section, grouped; a null title renders the group without a heading. */
const SECTION_LAYOUT: Record<
  GeneralSectionId,
  Array<{ title: ExtensionMessageKey | null; fields: string[] }>
> = {
  sensitivity: [
    {
      title: "optionsGroupMasking",
      fields: ["blockedSelectors", "redactHeaders", "redactBodyPatterns", "hashSensitiveValues"]
    }
  ],
  pointer: [{ title: null, fields: ["mousemoveHz", "scrollHz", "actionWindowMs"] }],
  sampling: [
    { title: "optionsGroupStart", fields: ["startReloadOffer"] },
    { title: "optionsGroupBuffer", fields: ["ringBufferMinutes", "freezeOnError"] },
    {
      title: "optionsGroupSampling",
      fields: ["domFlushMs", "snapshotIntervalMs", "screenshotIdleMs", "bodyCaptureMaxBytes"]
    }
  ],
  budgets: [
    {
      title: null,
      fields: [
        "budgetLcpWarnMs",
        "budgetRequestWarnMs",
        "budgetErrorRateWarnPct",
        "budgetAutoFreezeOnBreach"
      ]
    }
  ],
  export: [
    {
      title: "optionsGroupArchive",
      fields: ["archiveMaxSizeMb", "archiveRecentMinutes"]
    },
    { title: "optionsGroupPlayer", fields: ["playerUrl"] }
  ]
};

function fieldText(spec: GeneralFieldSpec, t: Translate): FieldText {
  const label = t(spec.label);

  return {
    label,
    ...(spec.hint ? { hint: t(spec.hint) } : {}),
    ...(spec.help ? { help: t(spec.help), helpLabel: t("optionsHelpAbout", { label }) } : {})
  };
}

function listValidator(spec: ListFieldSpec, t: Translate): (value: string) => string | null {
  switch (spec.validator) {
    case "selector":
      return selectorValidator(t);
    case "header":
      return headerValidator(t);
    case "none":
      return patternValidator(t);
  }
}

/** Values the organization's policy sets, by field id: shown read-only instead of the draft's. */
export type ManagedGeneralValues = Readonly<Record<string, string>>;

function renderField(
  spec: GeneralFieldSpec,
  draft: GeneralDraft,
  managed: ManagedGeneralValues,
  t: Translate
): HTMLElement {
  const text = fieldText(spec, t);

  switch (spec.kind) {
    case "number":
      return numberField({
        ...text,
        id: spec.id,
        value: String(spec.get(draft)),
        min: spec.zeroDisables ? 0 : spec.min,
        max: spec.max,
        ...(spec.step !== undefined ? { step: spec.step } : {}),
        ...(spec.unit ? { unit: t(EXTENSION_UNIT_LABEL_KEYS[spec.unit]) } : {}),
        ...(spec.slider ? { slider: true } : {})
      });
    case "toggle":
      return toggleField({ ...text, id: spec.id, checked: spec.get(draft) });
    case "text": {
      const managedValue = managed[spec.id];
      return textField({
        ...text,
        id: spec.id,
        value: managedValue ?? spec.get(draft),
        placeholder: t(spec.placeholder),
        mono: true,
        ...(managedValue !== undefined ? { hint: t(spec.managedHint), readOnly: true } : {})
      });
    }
    case "list":
      return chipListField({
        ...text,
        ...chipListOptions(t),
        id: `${spec.id}-input`,
        name: spec.id,
        values: spec.get(draft),
        placeholder: t(spec.placeholder),
        validate: listValidator(spec, t)
      });
  }
}

/** Field groups of a general section, filled from the draft. */
export function renderGeneralSection(
  section: GeneralSectionId,
  draft: GeneralDraft,
  t: Translate,
  managed: ManagedGeneralValues = {}
): HTMLElement {
  return el(
    "div",
    { className: "wb-section__groups", dataset: { generalSection: section } },
    SECTION_LAYOUT[section].map((group) =>
      fieldGroup(
        group.title ? t(group.title) : null,
        group.fields.flatMap((id) => {
          const spec = findField(id);
          return spec ? [renderField(spec, draft, managed, t)] : [];
        })
      )
    )
  );
}

export type GeneralFieldUpdate = {
  draft: GeneralDraft;
  fieldId: string;
  /** Inline error to keep on the field, or null when the value was accepted. */
  error: string | null;
};

/**
 * Applies an edit of a general field control to the draft. Returns null for controls that are
 * not general fields (e.g. the profiles editor sharing the page). Invalid numbers keep the draft
 * and report an inline error.
 */
export function applyGeneralFieldInput(
  control: EventTarget | null,
  draft: GeneralDraft,
  t: Translate
): GeneralFieldUpdate | null {
  if (!(control instanceof HTMLInputElement) || !control.closest("[data-general-section]")) {
    return null;
  }

  const spec = findField(control.name);

  if (!spec) {
    return null;
  }

  switch (spec.kind) {
    case "number": {
      const result = validateNumberField(spec, control.value);
      const error = result.ok ? null : t(result.key, result.vars);
      setFieldError(control, error);
      return {
        draft: result.ok ? spec.set(draft, result.value) : draft,
        fieldId: spec.id,
        error
      };
    }
    case "toggle":
      return { draft: spec.set(draft, control.checked), fieldId: spec.id, error: null };
    case "text": {
      const result = spec.validate(control.value);
      const error = result.ok ? null : t(result.key);
      setFieldError(control, error);
      return {
        draft: result.ok ? spec.set(draft, result.value) : draft,
        fieldId: spec.id,
        error
      };
    }
    case "list":
      return {
        draft: spec.set(
          draft,
          control.value
            .split("\n")
            .map((entry) => entry.trim())
            .filter(Boolean)
        ),
        fieldId: spec.id,
        error: null
      };
  }
}
