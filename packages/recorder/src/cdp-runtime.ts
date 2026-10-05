import type { ConsoleDetail } from "./console-normalizer.js";
import { MAX_CONSOLE_ENTRY_CHARS, MAX_FULL_STACK_FRAMES } from "./console-normalizer.js";
import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  compactText,
  formatV8CallFrames,
  sanitizeOptionalUrl,
  stripUndefined,
  toOneBased
} from "./normalizer-utils.js";

type ExceptionTextLimits = {
  messageChars: number;
  stackChars: number;
  stackFrames: number;
};

const COMPACT_LIMITS: ExceptionTextLimits = {
  messageChars: 2_000,
  stackChars: 8_000,
  stackFrames: 32
};
const FULL_LIMITS: ExceptionTextLimits = {
  messageChars: MAX_CONSOLE_ENTRY_CHARS,
  stackChars: MAX_CONSOLE_ENTRY_CHARS,
  stackFrames: MAX_FULL_STACK_FRAMES
};
const PROMISE_REJECTION_TEXT = "Uncaught (in promise)";
const V8_FRAME_PREFIX = "    at ";

/**
 * Projects a CDP `Runtime.exceptionThrown` event onto the same flat shape the page hooks emit for
 * `pageError` (`message`, `stack`, `filename`, 1-based `lineno`/`colno`). Remote object handles and
 * previews are dropped. Text fields stay here; the recorder strips them under the `console: metadata`
 * policy (see `applyErrorTextPolicy`). `full` detail (`console: allow`) keeps the whole message and
 * every CDP call frame: V8 cuts `Error.stack` at `Error.stackTraceLimit` (10), CDP goes deeper.
 */
export function normalizeCdpExceptionPayload(
  payload: unknown,
  detail: ConsoleDetail = "compact"
): Record<string, unknown> {
  const limits = detail === "full" ? FULL_LIMITS : COMPACT_LIMITS;
  const row = asRecord(payload) ?? {};
  const details = asRecord(row.exceptionDetails);

  if (!details) {
    return stripUndefined({
      source: "cdp.runtime",
      message: readText(row.message, limits.messageChars),
      name: asString(row.name),
      stack: readText(row.stack, limits.stackChars)
    });
  }

  const exception = asRecord(details.exception);
  const description = asString(exception?.description);
  const callFrames = asArray(asRecord(details.stackTrace)?.callFrames);
  const topFrame = asRecord(callFrames[0]);
  const header = description ? readDescriptionHeader(description) : undefined;
  const message =
    (detail === "full" ? header : description?.split("\n")[0]) ||
    readPrimitiveValue(exception) ||
    asString(details.text);
  const stack = readExceptionStack(description, header, callFrames, detail, limits);

  return stripUndefined({
    source: "cdp.runtime",
    message: readText(message, limits.messageChars),
    name: exception?.subtype === "error" ? asString(exception.className) : undefined,
    stack: readText(stack, limits.stackChars),
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

function readExceptionStack(
  description: string | undefined,
  header: string | undefined,
  callFrames: unknown[],
  detail: ConsoleDetail,
  limits: ExceptionTextLimits
): string | undefined {
  const formatted = formatV8CallFrames(callFrames, limits.stackFrames);

  if (!description?.includes("\n")) {
    return formatted;
  }

  const describedFrames = description
    .split("\n")
    .filter((line) => line.startsWith(V8_FRAME_PREFIX)).length;

  return detail === "full" && formatted && callFrames.length > describedFrames
    ? `${header}\n${formatted}`
    : description;
}

/** The message lines of an `Error.stack` text: everything before the first `    at` frame. */
function readDescriptionHeader(description: string): string {
  const lines = description.split("\n");
  const firstFrame = lines.findIndex((line) => line.startsWith(V8_FRAME_PREFIX));
  return (firstFrame < 0 ? lines : lines.slice(0, firstFrame)).join("\n");
}

function readText(value: unknown, maxChars: number): string | undefined {
  const text = asString(value);
  return text ? compactText(text, maxChars) : undefined;
}
