import {
  DEFAULT_CAPTURE_POLICY,
  redactKeystrokePayload,
  shouldRedactKeystroke,
  type CapturePolicy
} from "@webblackbox/protocol";

const EDITABLE_TARGET_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Re-applies the keystroke privacy rule to a `user.keydown` payload, whatever produced it.
 *
 * The recorder cannot inspect the DOM, so it trusts producer flags (`editable`,
 * `sensitiveTarget`) and otherwise falls back to the target tag. A payload without any target
 * information is treated as editable, so unknown producers fail closed.
 */
export function sanitizeKeydownPayload(
  payload: unknown,
  policy: CapturePolicy | undefined
): unknown {
  const row = asRecord(payload);

  if (!row) {
    return payload;
  }

  if (row.keyRedacted === true) {
    return redactKeystrokePayload(row);
  }

  const shouldRedact = shouldRedactKeystroke({
    key: typeof row.key === "string" ? row.key : "",
    ctrlKey: row.ctrlKey === true,
    metaKey: row.metaKey === true,
    altKey: row.altKey === true,
    editable: isEditableKeydownTarget(row),
    sensitive: row.sensitiveTarget === true,
    inputs: (policy ?? DEFAULT_CAPTURE_POLICY).categories.inputs
  });

  return shouldRedact ? redactKeystrokePayload(row) : row;
}

function isEditableKeydownTarget(row: Record<string, unknown>): boolean {
  if (typeof row.editable === "boolean") {
    return row.editable;
  }

  const target = asRecord(row.target);

  if (!target) {
    return true;
  }

  return typeof target.tag === "string" && EDITABLE_TARGET_TAGS.has(target.tag.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
