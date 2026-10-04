import type { CapturePolicy, WebBlackboxEventType } from "@webblackbox/protocol";

import { asRecord } from "./normalizer-utils.js";

/** Text-free fields an `error.*` event may keep under `console: metadata`; everything else goes. */
const ERROR_METADATA_KEYS = [
  "source",
  "filename",
  "lineno",
  "colno",
  "rejection",
  "exceptionId",
  "timestamp"
] as const;

/**
 * Under `console: metadata`, keeps uncaught exceptions and unhandled rejections as text-less
 * metadata, exactly like the page hooks do in lite mode (`messageRedacted`/`stackRedacted`,
 * `reasonRedacted`). Only known text-free fields are kept, whatever the source, so full-mode CDP
 * exceptions match lite.
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
    return { ...pickMetadata(row), messageRedacted: true, stackRedacted: true };
  }

  if (eventType === "error.unhandledrejection") {
    return { ...pickMetadata(row), reasonRedacted: true };
  }

  return payload;
}

function pickMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ERROR_METADATA_KEYS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])
  );
}
