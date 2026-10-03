import type { CapturePolicy } from "@webblackbox/protocol";

/** Longest raw input value kept on a `user.input` event. */
export const MAX_CAPTURED_INPUT_VALUE_CHARS = 1_000;

type EditableField = HTMLInputElement | HTMLTextAreaElement;

const PASSWORD_AUTOCOMPLETE_TOKENS = new Set(["current-password", "new-password", "one-time-code"]);

/**
 * Raw value of an edited field when the capture policy allows it, otherwise undefined.
 *
 * - `inputs: "allow"` keeps values except on fields matching a blocked selector (field or ancestor)
 *   that no unmask selector re-allows.
 * - `inputs: "masked"` keeps values only on fields that match an unmask selector.
 * - Password fields (type or autocomplete) are never captured, whatever the profile says.
 */
export function readCapturableInputValue(
  field: EditableField,
  policy: CapturePolicy
): string | undefined {
  const level = policy.categories.inputs;

  if ((level !== "allow" && level !== "masked") || isPasswordLikeField(field)) {
    return undefined;
  }

  const unmasked = matchesAnySelector(field, policy.redaction.unmaskSelectors ?? []);

  if (level === "masked" && !unmasked) {
    return undefined;
  }

  if (!unmasked && matchesAnySelector(field, policy.redaction.blockedSelectors)) {
    return undefined;
  }

  return field.value.slice(0, MAX_CAPTURED_INPUT_VALUE_CHARS);
}

function isPasswordLikeField(field: EditableField): boolean {
  if (field instanceof HTMLInputElement && field.type.toLowerCase() === "password") {
    return true;
  }

  const autocomplete = (field.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  return autocomplete.some((token) => PASSWORD_AUTOCOMPLETE_TOKENS.has(token));
}

function matchesAnySelector(field: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => {
    try {
      return field.closest(selector) !== null;
    } catch {
      // An invalid selector must fail closed for blocks and open nothing for unmasking.
      return false;
    }
  });
}
