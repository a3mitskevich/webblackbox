import type { CapturePolicy, WebBlackboxEventType } from "@webblackbox/protocol";

import { asRecord, omitKeys } from "./normalizer-utils.js";

const EXCEPTION_TEXT_KEYS = ["message", "name", "stack", "text"] as const;
const REJECTION_TEXT_KEYS = ["reason", "message", "stack", "text"] as const;

/**
 * Under `console: metadata`, keeps uncaught exceptions and unhandled rejections as text-less
 * metadata, exactly like the page hooks do in lite mode (`messageRedacted`/`stackRedacted`,
 * `reasonRedacted`). This applies to every source, so full-mode CDP exceptions match lite.
 */
export function applyErrorTextPolicy(
  eventType: WebBlackboxEventType,
  payload: unknown,
  capturePolicy: CapturePolicy | undefined
): unknown {
  if (capturePolicy?.categories.console !== "metadata") {
    return payload;
  }

  const row = asRecord(payload);

  if (!row) {
    return payload;
  }

  if (eventType === "error.exception") {
    return {
      ...omitKeys(row, EXCEPTION_TEXT_KEYS),
      messageRedacted: true,
      stackRedacted: true
    };
  }

  if (eventType === "error.unhandledrejection") {
    return { ...omitKeys(row, REJECTION_TEXT_KEYS), reasonRedacted: true };
  }

  return payload;
}
