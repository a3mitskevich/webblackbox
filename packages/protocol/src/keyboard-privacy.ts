import type { CapturePolicy } from "./types.js";

/** Replacement for a keystroke `key` that could reveal typed text. */
export const REDACTED_KEYSTROKE = "[REDACTED]";

const FUNCTION_KEY_PATTERN = /^F(?:[1-9]|1\d|2[0-4])$/;

/**
 * Non-printable keys that never reveal typed characters and are always safe to record.
 * Anything outside this list (letters, digits, punctuation, space, Shift, Dead, Process, ...)
 * is treated as potentially revealing typed text.
 */
const SERVICE_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

export type KeystrokeModifiers = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export type KeystrokePrivacyInput = KeystrokeModifiers & {
  key: string;
  /** Focus target is a text-entry control (text-like input, textarea, select, contenteditable). */
  editable: boolean;
  /** Focus target is a password input or matches a blocked selector. */
  sensitive: boolean;
  inputs: CapturePolicy["categories"]["inputs"];
};

/** Returns true for navigation/editing keys that do not reveal typed characters. */
export function isServiceKey(key: string): boolean {
  return SERVICE_KEYS.has(key) || FUNCTION_KEY_PATTERN.test(key);
}

/**
 * Returns true for Ctrl/Cmd shortcut chords (e.g. Ctrl+S).
 * Ctrl+Alt is excluded: on Windows it is AltGr, which types characters on many layouts.
 */
export function isShortcutChord(modifiers: KeystrokeModifiers): boolean {
  return (modifiers.ctrlKey === true || modifiers.metaKey === true) && modifiers.altKey !== true;
}

/**
 * Decides whether a keystroke's `key`/`code` must be dropped before it is stored.
 *
 * - Service keys are always kept.
 * - Sensitive targets (password, blocked selectors) never keep anything else, whatever the policy.
 * - Editable targets keep shortcut chords; other keys are kept only with `inputs: "allow"`.
 * - Non-editable targets are not text entry, so keys are kept (page hotkeys).
 */
export function shouldRedactKeystroke(input: KeystrokePrivacyInput): boolean {
  if (isServiceKey(input.key)) {
    return false;
  }

  if (input.sensitive) {
    return true;
  }

  if (!input.editable || input.inputs === "allow") {
    return false;
  }

  return !isShortcutChord(input);
}

/** Returns a copy of a keystroke payload with the typed key replaced and `code` dropped. */
export function redactKeystrokePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const withoutCode = Object.fromEntries(
    Object.entries(payload).filter(([field]) => field !== "code")
  );

  return {
    ...withoutCode,
    key: REDACTED_KEYSTROKE,
    keyRedacted: true
  };
}
