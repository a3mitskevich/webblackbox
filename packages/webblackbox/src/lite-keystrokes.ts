import {
  isContentRedactionEnabled,
  redactKeystrokePayload,
  shouldRedactKeystroke,
  type CapturePolicy
} from "@webblackbox/protocol";

import { stripUndefinedRecord } from "./lite-target-payload.js";

// Input types whose keystrokes do not enter text (e.g. Space toggles a checkbox).
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit"
]);
const PASSWORD_INPUT_SELECTOR = "input[type='password']";

/** Keydown payload; the key is redacted when it is typed into a sensitive or masked field. */
export function createKeydownPayload(
  event: KeyboardEvent,
  capturePolicy: CapturePolicy,
  targetPayload: (target: EventTarget | null) => Record<string, unknown>
): Record<string, unknown> {
  const focusTarget = resolveComposedTarget(event);
  const editable = isKeystrokeEditableTarget(focusTarget);
  // Masking off (`contentRedaction: false`): keys are recorded as typed, passwords included.
  const sensitive =
    isContentRedactionEnabled(capturePolicy.redaction) &&
    isSensitiveKeystrokeTarget(focusTarget, capturePolicy.redaction.blockedSelectors);
  const payload = stripUndefinedRecord({
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    editable: editable,
    sensitiveTarget: sensitive,
    target: targetPayload(event.target)
  });
  const shouldRedact = shouldRedactKeystroke({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    editable,
    sensitive,
    inputs: capturePolicy.categories.inputs
  });

  return shouldRedact ? redactKeystrokePayload(payload) : payload;
}

export function isEditableInteractionTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return true;
  }

  return isRichTextEditableTarget(target);
}

/** Real focus target, including elements inside open shadow roots (event.target is retargeted). */
function resolveComposedTarget(event: Event): EventTarget | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return path[0] ?? event.target;
}

function isKeystrokeEditableTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }

  return isRichTextEditableTarget(target);
}

function isSensitiveKeystrokeTarget(
  target: EventTarget | null,
  blockedSelectors: readonly string[]
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  return [PASSWORD_INPUT_SELECTOR, ...blockedSelectors].some((selector) =>
    matchesClosestSelector(target, selector)
  );
}

function matchesClosestSelector(target: Element, selector: string): boolean {
  try {
    return target.closest(selector) !== null;
  } catch {
    // Invalid user-provided selectors must not break capture.
    return false;
  }
}

export function isRichTextEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const directValue = target.getAttribute("contenteditable");

  if (directValue === "" || directValue === "true" || directValue === "plaintext-only") {
    return true;
  }

  return (
    target.closest(
      "[contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']"
    ) !== null
  );
}
