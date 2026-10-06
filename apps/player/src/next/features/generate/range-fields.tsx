import { useId, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { isSameRange, MIN_RANGE_MS, type TimeRange } from "../../../core/time-range.js";
import { useI18n, usePlayerState } from "../../context.js";
import type { LoadedArchive } from "../../state.js";
import type { GenerateTranslate } from "./messages.js";
import {
  commitTypedRange,
  formatRangeLabel,
  rangeText,
  type RangeField,
  type RangeText,
  type TypedRangeResult
} from "./range.js";

type RangeError = Extract<TypedRangeResult, { status: "invalid" }>;

/** The typed text and its error, for the applied `range` they were typed against. */
type Draft = {
  range: TimeRange | null;
  text: RangeText;
  error: RangeError | null;
};

type RangeFieldsProps = {
  archive: LoadedArchive;
  range: TimeRange | null;
  timelineRange: TimeRange | null;
  onChange: (range: TimeRange | null) => void;
  t: GenerateTranslate;
};

/**
 * From / To in seconds (the classic dialog's fields), plus "Whole session" and "Timeline range".
 * A typed value applies on Enter, on leaving the field or with "Regenerate"; a value that is not a
 * number or a range under 50 ms shows an error and keeps the applied range. The fields are never
 * remounted, so a preset clicked right after typing (blur, then click) still lands.
 */
export function RangeFields({ archive, range, timelineRange, onChange, t }: RangeFieldsProps) {
  const i18n = useI18n();
  const locale = usePlayerState((state) => state.locale);
  const { minMono, maxMono, durationMono } = archive.model;
  const bounds = { minMono, maxMono };
  const [draft, setDraft] = useState<Draft>(() => ({
    range,
    text: rangeText(range, bounds),
    error: null
  }));
  const fromId = useId();
  const toId = useId();
  const errorId = useId();

  // A range applied from outside (a preset, the dialog's start) shows its own text again.
  const current: Draft = isSameRange(draft.range, range)
    ? draft
    : { range, text: rangeText(range, bounds), error: null };

  if (current !== draft) {
    setDraft(current);
  }

  const commit = (): void => {
    const result = commitTypedRange(current.text, range, bounds);

    if (result.status === "unchanged") {
      return;
    }

    if (result.status === "invalid") {
      setDraft({ ...current, error: result });
      return;
    }

    setDraft({ range: result.range, text: rangeText(result.range, bounds), error: null });
    onChange(result.range);
  };

  // A preset also drops whatever was typed (even when the applied range does not change).
  const applyPreset = (next: TimeRange | null): void => {
    setDraft({ range: next, text: rangeText(next, bounds), error: null });
    onChange(next);
  };

  const edit = (field: RangeField, value: string): void => {
    setDraft({ ...current, text: { ...current.text, [field]: value }, error: null });
  };

  // Enter applies the typed range (and does not submit the dialog's form).
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  const { error } = current;
  const fieldProps = (field: RangeField) => ({
    className: "text-input",
    inputMode: "decimal" as const,
    value: current.text[field],
    "aria-invalid": error?.fields.includes(field) ? true : undefined,
    "aria-describedby": error ? errorId : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement>) => edit(field, event.target.value),
    onBlur: commit,
    onKeyDown: handleKeyDown,
    "data-testid": `generate-range-${field}`
  });

  const label = formatRangeLabel(range, minMono, locale);
  const duration = i18n.formatSeconds(durationMono);

  return (
    <fieldset className="gen-range" data-testid="generate-range">
      <legend>{t("rangeLegend")}</legend>
      <label className="gen-field" htmlFor={fromId}>
        {t("rangeFrom")}
        <input id={fromId} {...fieldProps("from")} />
      </label>
      <label className="gen-field" htmlFor={toId}>
        {t("rangeTo")}
        <input id={toId} {...fieldProps("to")} />
      </label>
      <button
        type="button"
        className="btn small"
        aria-pressed={range === null}
        onClick={() => applyPreset(null)}
        data-testid="generate-range-whole"
      >
        {t("rangeWhole")}
      </button>
      {timelineRange ? (
        <button
          type="button"
          className="btn small"
          aria-pressed={isSameRange(range, timelineRange)}
          onClick={() => applyPreset(timelineRange)}
          data-testid="generate-range-timeline"
        >
          {t("rangeTimeline")}
        </button>
      ) : null}
      <span className="gen-range-summary" data-testid="generate-range-summary">
        {label
          ? t("rangeSummary", { range: label, duration })
          : t("rangeSummaryWhole", { duration })}
      </span>
      {error ? (
        <p
          id={errorId}
          className="field-error gen-range-error"
          role="alert"
          data-testid="generate-range-error"
        >
          {error.reason === "too-short"
            ? t("rangeTooShort", { min: MIN_RANGE_MS })
            : t("rangeInvalid")}
        </p>
      ) : null}
    </fieldset>
  );
}
