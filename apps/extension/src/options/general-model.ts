import { DEFAULT_RECORDER_CONFIG, type RecorderConfig } from "@webblackbox/protocol";

import {
  ARCHIVE_SIZE_MB_LIMITS,
  DEFAULT_EXPORT_POLICY_PREFS,
  RECENT_WINDOW_MINUTES_LIMITS,
  type ExportPolicyPrefs
} from "../shared/export-policy-prefs.js";
import type { ExtensionMessageKey, ExtensionUnit } from "../shared/i18n.js";
import { OPTIONS_STORAGE_VERSION } from "../shared/options-storage.js";
import {
  DEFAULT_PERFORMANCE_BUDGET,
  normalizePerformanceBudget,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";

/**
 * Pure model of the general settings (everything outside the profiles editor): the draft being
 * edited, field specs with limits and units, validation, per-section reset and the stored payload.
 */

export type GeneralDraft = {
  recorderConfig: RecorderConfig;
  performanceBudget: PerformanceBudgetConfig;
  archive: ExportPolicyPrefs;
};

export type GeneralSectionId = "sensitivity" | "pointer" | "sampling" | "budgets" | "export";

const MAX_BODY_CAPTURE_BYTES = 1_048_576;
const MIN_SCREENSHOT_IDLE_MS = 250;

type SpecText = {
  id: string;
  section: GeneralSectionId;
  label: ExtensionMessageKey;
  hint?: ExtensionMessageKey;
  help?: ExtensionMessageKey;
};

export type NumberFieldSpec = SpecText & {
  kind: "number";
  unit?: ExtensionUnit;
  min: number;
  max: number;
  step?: number;
  slider?: boolean;
  /** 0 is accepted below `min` and means "off". */
  zeroDisables?: boolean;
  get: (draft: GeneralDraft) => number;
  set: (draft: GeneralDraft, value: number) => GeneralDraft;
};

export type ToggleFieldSpec = SpecText & {
  kind: "toggle";
  get: (draft: GeneralDraft) => boolean;
  set: (draft: GeneralDraft, value: boolean) => GeneralDraft;
};

export type ListValidator = "selector" | "header" | "none";

export type ListFieldSpec = SpecText & {
  kind: "list";
  placeholder: ExtensionMessageKey;
  validator: ListValidator;
  get: (draft: GeneralDraft) => readonly string[];
  set: (draft: GeneralDraft, value: string[]) => GeneralDraft;
};

export type GeneralFieldSpec = NumberFieldSpec | ToggleFieldSpec | ListFieldSpec;

type SamplingKey = keyof RecorderConfig["sampling"];
type BudgetNumberKey = "lcpWarnMs" | "requestWarnMs" | "errorRateWarnPct";
type RedactionListKey = "blockedSelectors" | "redactHeaders" | "redactBodyPatterns";

const withConfig = (draft: GeneralDraft, patch: Partial<RecorderConfig>): GeneralDraft => ({
  ...draft,
  recorderConfig: { ...draft.recorderConfig, ...patch }
});

const withSampling = (
  draft: GeneralDraft,
  patch: Partial<RecorderConfig["sampling"]>
): GeneralDraft => withConfig(draft, { sampling: { ...draft.recorderConfig.sampling, ...patch } });

const withRedaction = (
  draft: GeneralDraft,
  patch: Partial<RecorderConfig["redaction"]>
): GeneralDraft =>
  withConfig(draft, { redaction: { ...draft.recorderConfig.redaction, ...patch } });

const withBudget = (
  draft: GeneralDraft,
  patch: Partial<PerformanceBudgetConfig>
): GeneralDraft => ({
  ...draft,
  performanceBudget: { ...draft.performanceBudget, ...patch }
});

const withArchive = (draft: GeneralDraft, patch: Partial<ExportPolicyPrefs>): GeneralDraft => ({
  ...draft,
  archive: { ...draft.archive, ...patch }
});

type NumberSpecOptions = Omit<NumberFieldSpec, "kind" | "id" | "get" | "set">;

function samplingNumber(key: SamplingKey, spec: NumberSpecOptions): NumberFieldSpec {
  return {
    kind: "number",
    id: key,
    ...spec,
    get: (draft) => draft.recorderConfig.sampling[key],
    set: (draft, value) => withSampling(draft, { [key]: value })
  };
}

function budgetNumber(
  key: BudgetNumberKey,
  id: string,
  spec: Omit<NumberSpecOptions, "section">
): NumberFieldSpec {
  return {
    kind: "number",
    id,
    section: "budgets",
    ...spec,
    get: (draft) => draft.performanceBudget[key],
    set: (draft, value) => withBudget(draft, { [key]: value })
  };
}

function redactionList(
  key: RedactionListKey,
  spec: Omit<ListFieldSpec, "kind" | "id" | "get" | "set" | "section">
): ListFieldSpec {
  return {
    kind: "list",
    id: key,
    section: "sensitivity",
    ...spec,
    get: (draft) => draft.recorderConfig.redaction[key],
    set: (draft, value) => withRedaction(draft, { [key]: value })
  };
}

export const GENERAL_FIELDS: readonly GeneralFieldSpec[] = [
  redactionList("blockedSelectors", {
    label: "optionsBlockedSelectors",
    hint: "optionsBlockedSelectorsHint",
    help: "optionsBlockedSelectorsHelp",
    placeholder: "optionsSelectorPlaceholder",
    validator: "selector"
  }),
  redactionList("redactHeaders", {
    label: "optionsRedactedHeaders",
    hint: "optionsRedactedHeadersHint",
    placeholder: "optionsHeaderPlaceholder",
    validator: "header"
  }),
  redactionList("redactBodyPatterns", {
    label: "optionsBodySensitivePatterns",
    hint: "optionsBodySensitivePatternsHint",
    help: "optionsBodySensitivePatternsHelp",
    placeholder: "optionsPatternPlaceholder",
    validator: "none"
  }),
  {
    kind: "toggle",
    id: "hashSensitiveValues",
    section: "sensitivity",
    label: "optionsHashSensitiveValues",
    hint: "optionsHashSensitiveValuesHint",
    get: (draft) => draft.recorderConfig.redaction.hashSensitiveValues,
    set: (draft, value) => withRedaction(draft, { hashSensitiveValues: value })
  },
  samplingNumber("mousemoveHz", {
    section: "pointer",
    label: "optionsMousemoveHz",
    hint: "optionsMousemoveHzHint",
    unit: "Hz",
    min: 1,
    max: 240,
    slider: true
  }),
  samplingNumber("scrollHz", {
    section: "pointer",
    label: "optionsScrollHz",
    hint: "optionsScrollHzHint",
    unit: "Hz",
    min: 1,
    max: 120,
    slider: true
  }),
  samplingNumber("actionWindowMs", {
    section: "pointer",
    label: "optionsActionWindowMs",
    hint: "optionsActionWindowHint",
    help: "optionsActionWindowHelp",
    unit: "ms",
    min: 100,
    max: 10_000,
    step: 100
  }),
  {
    kind: "number",
    id: "ringBufferMinutes",
    section: "sampling",
    label: "optionsRingBufferMinutes",
    hint: "optionsRingBufferHint",
    help: "optionsRingBufferHelp",
    unit: "min",
    min: 1,
    max: 120,
    slider: true,
    get: (draft) => draft.recorderConfig.ringBufferMinutes,
    set: (draft, value) => withConfig(draft, { ringBufferMinutes: value })
  },
  samplingNumber("domFlushMs", {
    section: "sampling",
    label: "optionsDomFlushMs",
    hint: "optionsDomFlushHint",
    unit: "ms",
    min: 25,
    max: 10_000,
    step: 25
  }),
  samplingNumber("snapshotIntervalMs", {
    section: "sampling",
    label: "optionsSnapshotIntervalMs",
    hint: "optionsSnapshotIntervalHint",
    unit: "ms",
    min: 500,
    max: 120_000,
    step: 500
  }),
  samplingNumber("screenshotIdleMs", {
    section: "sampling",
    label: "optionsScreenshotIdleMs",
    hint: "optionsScreenshotIdleHint",
    help: "optionsScreenshotIdleHelp",
    unit: "ms",
    min: MIN_SCREENSHOT_IDLE_MS,
    max: 120_000,
    step: 250,
    zeroDisables: true
  }),
  samplingNumber("bodyCaptureMaxBytes", {
    section: "sampling",
    label: "optionsBodyCaptureMaxBytes",
    hint: "optionsBodyCaptureHint",
    help: "optionsBodyCaptureHelp",
    unit: "B",
    min: 0,
    max: MAX_BODY_CAPTURE_BYTES,
    step: 1024
  }),
  {
    kind: "toggle",
    id: "freezeOnError",
    section: "sampling",
    label: "optionsFreezeOnError",
    hint: "optionsFreezeOnErrorHint",
    help: "optionsFreezeHelp",
    get: (draft) => draft.recorderConfig.freezeOnError,
    set: (draft, value) => withConfig(draft, { freezeOnError: value })
  },
  budgetNumber("lcpWarnMs", "budgetLcpWarnMs", {
    label: "optionsLcpWarnMs",
    hint: "optionsLcpWarnHint",
    unit: "ms",
    min: 500,
    max: 30_000,
    step: 100
  }),
  budgetNumber("requestWarnMs", "budgetRequestWarnMs", {
    label: "optionsRequestWarnMs",
    hint: "optionsRequestWarnHint",
    unit: "ms",
    min: 100,
    max: 60_000,
    step: 100
  }),
  budgetNumber("errorRateWarnPct", "budgetErrorRateWarnPct", {
    label: "optionsErrorRateWarnPct",
    hint: "optionsErrorRateWarnHint",
    unit: "%",
    min: 1,
    max: 100,
    slider: true
  }),
  {
    kind: "toggle",
    id: "budgetAutoFreezeOnBreach",
    section: "budgets",
    label: "optionsAutoFreezeOnBreach",
    hint: "optionsAutoFreezeHint",
    get: (draft) => draft.performanceBudget.autoFreezeOnBreach,
    set: (draft, value) => withBudget(draft, { autoFreezeOnBreach: value })
  },
  {
    kind: "toggle",
    id: "archiveAlertSensitiveFindings",
    section: "export",
    label: "optionsAlertSensitiveFindings",
    hint: "optionsAlertSensitiveFindingsHint",
    get: (draft) => draft.archive.alertSensitiveFindings,
    set: (draft, value) => withArchive(draft, { alertSensitiveFindings: value })
  },
  {
    kind: "number",
    id: "archiveMaxSizeMb",
    section: "export",
    label: "optionsMaxArchiveSize",
    hint: "optionsMaxArchiveSizeHint",
    unit: "MB",
    min: ARCHIVE_SIZE_MB_LIMITS.min,
    max: ARCHIVE_SIZE_MB_LIMITS.max,
    get: (draft) => draft.archive.maxArchiveMb,
    set: (draft, value) => withArchive(draft, { maxArchiveMb: value })
  },
  {
    kind: "number",
    id: "archiveRecentMinutes",
    section: "export",
    label: "optionsRecentWindow",
    hint: "optionsRecentWindowHint",
    help: "optionsRecentWindowHelp",
    unit: "min",
    min: RECENT_WINDOW_MINUTES_LIMITS.min,
    max: RECENT_WINDOW_MINUTES_LIMITS.max,
    get: (draft) => draft.archive.recentMinutes,
    set: (draft, value) => withArchive(draft, { recentMinutes: value })
  }
];

export function fieldsOfSection(section: GeneralSectionId): GeneralFieldSpec[] {
  return GENERAL_FIELDS.filter((spec) => spec.section === section);
}

export function findField(id: string): GeneralFieldSpec | undefined {
  return GENERAL_FIELDS.find((spec) => spec.id === id);
}

export type NumberValidation =
  | { ok: true; value: number }
  | { ok: false; key: ExtensionMessageKey; vars?: Record<string, string | number> };

export function validateNumberField(spec: NumberFieldSpec, raw: string): NumberValidation {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return { ok: false, key: "optionsErrorRequired" };
  }

  const value = Number(trimmed);

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, key: "optionsErrorWholeNumber" };
  }

  if (spec.zeroDisables && value === 0) {
    return { ok: true, value };
  }

  if (value < spec.min || value > spec.max) {
    return {
      ok: false,
      key: spec.zeroDisables ? "optionsErrorRangeOrZero" : "optionsErrorRange",
      vars: { min: spec.min, max: spec.max }
    };
  }

  return { ok: true, value };
}

/** Freeze triggers the shipped runtime keeps off, and the body capture cap. */
export function normalizeOptionsConfig(config: RecorderConfig): RecorderConfig {
  const bodyCaptureMaxBytes = config.sampling.bodyCaptureMaxBytes;

  return {
    ...config,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...config.sampling,
      bodyCaptureMaxBytes: Number.isFinite(bodyCaptureMaxBytes)
        ? Math.min(MAX_BODY_CAPTURE_BYTES, Math.max(0, Math.round(bodyCaptureMaxBytes)))
        : DEFAULT_RECORDER_CONFIG.sampling.bodyCaptureMaxBytes
    }
  };
}

export function createDefaultGeneralDraft(): GeneralDraft {
  return {
    recorderConfig: normalizeOptionsConfig(structuredClone(DEFAULT_RECORDER_CONFIG)),
    performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET },
    archive: { ...DEFAULT_EXPORT_POLICY_PREFS }
  };
}

/** The draft with every field of `section` back at its default; other sections are untouched. */
export function resetGeneralSection(draft: GeneralDraft, section: GeneralSectionId): GeneralDraft {
  const defaults = createDefaultGeneralDraft();

  return fieldsOfSection(section).reduce<GeneralDraft>((next, spec) => {
    switch (spec.kind) {
      case "number":
        return spec.set(next, spec.get(defaults));
      case "toggle":
        return spec.set(next, spec.get(defaults));
      case "list":
        return spec.set(next, [...spec.get(defaults)]);
    }
  }, draft);
}

/** `webblackbox.options` record for the general settings; fields the page does not show stay. */
export function toStoredOptionsPayload(draft: GeneralDraft): Record<string, unknown> {
  return {
    ...normalizeOptionsConfig(draft.recorderConfig),
    optionsVersion: OPTIONS_STORAGE_VERSION,
    performanceBudget: normalizePerformanceBudget(draft.performanceBudget)
  };
}

/** Whether the parts stored in `webblackbox.options` differ (archive prefs live elsewhere). */
export function isStoredOptionsChanged(draft: GeneralDraft, baseline: GeneralDraft): boolean {
  return (
    JSON.stringify(toStoredOptionsPayload(draft)) !==
    JSON.stringify(toStoredOptionsPayload(baseline))
  );
}

export function isArchiveChanged(draft: GeneralDraft, baseline: GeneralDraft): boolean {
  return JSON.stringify(draft.archive) !== JSON.stringify(baseline.archive);
}
