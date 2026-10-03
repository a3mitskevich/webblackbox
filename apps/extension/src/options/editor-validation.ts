import type { ExtensionMessageKey } from "../shared/i18n.js";
import { compileTitleRegex } from "../shared/profiles/title-regex.js";
import { isValidSelector, reportFieldProblem } from "./fields.js";

/** Inline checks for the profile and rule editor inputs (values are read back from the DOM). */

type Translate = (key: ExtensionMessageKey, vars?: Record<string, string | number>) => string;

/** Rule fields whose value must parse: a CSS selector and a (safe) title pattern. */
const RULE_TEXT_VALIDATORS: Record<string, (value: string, t: Translate) => string | null> = {
  ruleSelector: (value, t) => (isValidSelector(value) ? null : t("optionsErrorSelector")),
  ruleTitleRegex: (value, t) => (compileTitleRegex(value) ? null : t("optionsErrorTitleRegex"))
};

/** Shows the problem inline and reports it to the page, which then blocks Save. */
export function validateRuleTextInput(input: HTMLInputElement, t: Translate): void {
  const validate = Object.hasOwn(RULE_TEXT_VALIDATORS, input.name)
    ? RULE_TEXT_VALIDATORS[input.name]
    : undefined;
  const value = input.value.trim();

  if (validate) {
    reportFieldProblem(input, value ? validate(value, t) : null);
  }
}

/** Re-checks rule fields after a render, which rebuilds them without their error state. */
export function validateRuleTextFields(container: HTMLElement, t: Translate): void {
  container
    .querySelectorAll<HTMLInputElement>("input[name='ruleSelector'], input[name='ruleTitleRegex']")
    .forEach((input) => validateRuleTextInput(input, t));
}

/**
 * Optional numbers: empty means "inherit"; anything else must be a whole number in range. An
 * invalid value blocks Save; saving would otherwise clamp or drop it without a word.
 */
export function validateRangeInput(input: HTMLInputElement, t: Translate): void {
  const raw = input.value.trim();
  const value = Number(raw);
  const min = Number(input.min);
  const max = Number(input.max);
  const invalid = raw !== "" && (!Number.isInteger(value) || value < min || value > max);

  reportFieldProblem(input, invalid ? t("optionsErrorRange", { min, max }) : null);
}

export type InvalidRangeInputs = ReadonlyArray<{ id: string; owner: string; value: string }>;

/** The rule row or profile form an input belongs to; ids repeat across profile forms. */
function ownerOf(input: Element): string {
  const rule = input.closest<HTMLElement>("[data-rule-id]")?.dataset.ruleId;
  const form = input.closest<HTMLElement>("[data-profile-form]")?.dataset.profileForm;

  return rule !== undefined ? `rule:${rule}` : form !== undefined ? `profile:${form}` : "";
}

/** Out-of-range numbers as typed; the draft only holds them clamped. */
export function captureInvalidRangeInputs(
  root: HTMLElement,
  options: { includeProfileForm: boolean }
): InvalidRangeInputs {
  return Array.from(
    root.querySelectorAll<HTMLInputElement>("input[type='number'][aria-invalid='true']"),
    (input) => ({ id: input.id, owner: ownerOf(input), value: input.value })
  ).filter(
    (entry) =>
      entry.id !== "" && (options.includeProfileForm || !entry.owner.startsWith("profile:"))
  );
}

/**
 * Puts typed out-of-range numbers back after a render rebuilt their inputs from the clamped
 * draft, so the error (and the Save block) stays until the user fixes the value.
 */
export function restoreInvalidRangeInputs(
  root: HTMLElement,
  inputs: InvalidRangeInputs,
  t: Translate
): void {
  for (const { id, owner, value } of inputs) {
    const input = root.ownerDocument.getElementById(id);

    if (input instanceof HTMLInputElement && root.contains(input) && ownerOf(input) === owner) {
      input.value = value;
      validateRangeInput(input, t);
    }
  }
}

/** Actions that close or replace the open profile form. */
const FORM_LEAVING_ACTIONS = new Set(["profile-edit", "profile-duplicate", "profile-apply"]);

/**
 * Leaving the profile form would fold its out-of-range numbers into the draft clamped, without a
 * word; instead the action waits and focus goes to the first such number.
 */
export function blocksLeavingProfileForm(action: string, root: HTMLElement): boolean {
  const invalid = FORM_LEAVING_ACTIONS.has(action)
    ? root.querySelector<HTMLInputElement>(
        "[data-profile-form] input[type='number'][aria-invalid='true']"
      )
    : null;

  invalid?.focus();
  return invalid !== null;
}
