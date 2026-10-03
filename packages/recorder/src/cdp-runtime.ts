import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  compactText,
  sanitizeOptionalUrl,
  stripUndefined
} from "./normalizer-utils.js";

const MAX_EXCEPTION_MESSAGE_CHARS = 2_000;
const MAX_EXCEPTION_STACK_CHARS = 8_000;
const MAX_STACK_FRAMES = 32;
const PROMISE_REJECTION_TEXT = "Uncaught (in promise)";

/**
 * Projects a CDP `Runtime.exceptionThrown` event onto the same flat shape the page hooks emit for
 * `pageError` (`message`, `stack`, `filename`, 1-based `lineno`/`colno`). Remote object handles and
 * previews are dropped. Text fields stay here; the recorder strips them under the `console: metadata`
 * policy (see `applyErrorTextPolicy`).
 */
export function normalizeCdpExceptionPayload(payload: unknown): Record<string, unknown> {
  const row = asRecord(payload) ?? {};
  const details = asRecord(row.exceptionDetails);

  if (!details) {
    return stripUndefined({
      source: "cdp.runtime",
      message: readText(row.message, MAX_EXCEPTION_MESSAGE_CHARS),
      name: asString(row.name),
      stack: readText(row.stack, MAX_EXCEPTION_STACK_CHARS)
    });
  }

  const exception = asRecord(details.exception);
  const description = asString(exception?.description);
  const stackTrace = asRecord(details.stackTrace);
  const topFrame = asRecord(asArray(stackTrace?.callFrames)[0]);
  const message =
    description?.split("\n")[0] || readPrimitiveValue(exception) || asString(details.text);
  const stack = description?.includes("\n") ? description : formatCallFrames(stackTrace);

  return stripUndefined({
    source: "cdp.runtime",
    message: readText(message, MAX_EXCEPTION_MESSAGE_CHARS),
    name: exception?.subtype === "error" ? asString(exception.className) : undefined,
    stack: readText(stack, MAX_EXCEPTION_STACK_CHARS),
    filename: sanitizeOptionalUrl(asString(details.url) || asString(topFrame?.url)),
    lineno: toOneBased(details.lineNumber),
    colno: toOneBased(details.columnNumber),
    rejection: asString(details.text)?.startsWith(PROMISE_REJECTION_TEXT) ? true : undefined,
    exceptionId: asFiniteNumber(details.exceptionId) ?? undefined,
    timestamp: asFiniteNumber(row.timestamp) ?? undefined
  });
}

function readPrimitiveValue(exception: Record<string, unknown> | null): string | undefined {
  if (!exception) {
    return undefined;
  }

  const value = exception.value;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return asString(exception.unserializableValue);
}

function formatCallFrames(stackTrace: Record<string, unknown> | null): string | undefined {
  const frames = asArray(stackTrace?.callFrames)
    .slice(0, MAX_STACK_FRAMES)
    .map((entry) => asRecord(entry))
    .filter((frame): frame is Record<string, unknown> => frame !== null)
    .map((frame) => {
      const functionName = asString(frame.functionName) || "(anonymous)";
      const url = sanitizeOptionalUrl(asString(frame.url)) ?? "(unknown)";
      return `    at ${functionName} (${url}:${toOneBased(frame.lineNumber) ?? 0}:${toOneBased(frame.columnNumber) ?? 0})`;
    });

  return frames.length > 0 ? frames.join("\n") : undefined;
}

function toOneBased(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  return numeric === null ? undefined : numeric + 1;
}

function readText(value: unknown, maxChars: number): string | undefined {
  const text = asString(value);
  return text ? compactText(text, maxChars) : undefined;
}
