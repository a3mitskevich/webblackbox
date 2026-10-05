import { CONSOLE_FULL_ENTRY_MAX_CHARS, CONSOLE_FULL_STACK_MAX_FRAMES } from "@webblackbox/protocol";

import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  compactText,
  formatV8CallFrames,
  sanitizeOptionalUrl,
  stripUndefined
} from "./normalizer-utils.js";

/**
 * How much of a console entry is kept: `full` under the `console: allow` policy (complete text and
 * stacks, up to {@link MAX_CONSOLE_ENTRY_CHARS}), `compact` otherwise (the legacy short previews).
 */
export type ConsoleDetail = "compact" | "full";

/** Ceiling for one console entry under `full` detail: its text, and all its arguments together. */
export const MAX_CONSOLE_ENTRY_CHARS = CONSOLE_FULL_ENTRY_MAX_CHARS;
/** Max call frames kept in a `full` stack (Chrome captures up to 200 for console messages). */
export const MAX_FULL_STACK_FRAMES = CONSOLE_FULL_STACK_MAX_FRAMES;

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

type SerializeShape = {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxTextArgs: number;
};

/** Cuts the strings of one entry; `full` shares one budget across all of its arguments. */
type TextLimiter = {
  cutString: (value: string) => string;
  cutDescription: (value: string) => string;
  cutErrorStack: (value: string) => string;
  cutText: (value: string) => string;
  isTruncated: () => boolean;
};

const COMPACT_SHAPE: SerializeShape = {
  maxDepth: 4,
  maxArrayItems: 16,
  maxObjectKeys: 24,
  maxTextArgs: 8
};
const FULL_SHAPE: SerializeShape = {
  maxDepth: 8,
  maxArrayItems: 256,
  maxObjectKeys: 256,
  maxTextArgs: 64
};
/** Console methods / log levels whose `full` entries carry the whole stack, not just `stackTop`. */
const FULL_STACK_METHODS = new Set(["error", "warning", "warn", "assert", "trace"]);

export function normalizeCdpConsolePayload(
  rawType: string,
  payload: unknown,
  detail: ConsoleDetail = "compact"
): Record<string, unknown> {
  const limiter = createTextLimiter(detail);

  if (rawType === "Log.entryAdded") {
    const row = asRecord(payload);
    const entry = asRecord(row?.entry);
    const rawText = asString(entry?.text) ?? "";
    // The legacy compact shape never cut log entry text; full detail caps it at the entry ceiling.
    const text = detail === "full" ? limiter.cutText(rawText) : rawText;
    const method = asString(entry?.source) ?? "log.entry";
    const level = asString(entry?.level) ?? method;
    const stackTrace = asRecord(entry?.stackTrace);

    return stripUndefined({
      source: "cdp.log",
      level: normalizeConsoleLevel(level),
      method,
      text: text || "(empty log entry)",
      args: text ? [text] : [],
      stackTop: readStackTop(stackTrace),
      stack: readFullStack(detail, level, stackTrace),
      truncated: limiter.isTruncated() || undefined,
      url: asString(entry?.url),
      line: asFiniteNumber(entry?.lineNumber) ?? undefined,
      col: asFiniteNumber(entry?.columnNumber) ?? undefined,
      networkRequestId: asString(entry?.networkRequestId),
      workerId: asString(entry?.workerId),
      timestamp: asFiniteNumber(entry?.timestamp) ?? undefined
    });
  }

  const row = asRecord(payload);
  const method = asString(row?.type) ?? "log";
  const shape = resolveShape(detail);
  const args = asArray(row?.args).map((entry) =>
    normalizeCdpRemoteObject(entry, shape, limiter, detail === "full")
  );
  const text = readEntryText(asString(row?.text), args, detail, limiter);
  const stackTrace = asRecord(row?.stackTrace);

  return stripUndefined({
    source: "cdp.runtime",
    level: normalizeConsoleLevel(method),
    method,
    text,
    args,
    stackTop: readStackTop(stackTrace),
    stack: readFullStack(detail, method, stackTrace),
    truncated: limiter.isTruncated() || undefined,
    executionContextId: asFiniteNumber(row?.executionContextId) ?? undefined,
    timestamp: asFiniteNumber(row?.timestamp) ?? undefined
  });
}

export function normalizeContentConsolePayload(
  payload: unknown,
  detail: ConsoleDetail = "compact"
): Record<string, unknown> {
  const row = asRecord(payload);
  const method = asString(row?.method) ?? "log";
  const shape = resolveShape(detail);
  const limiter = createTextLimiter(detail);
  const args = asArray(row?.args).map((entry) => sanitizeSerializable(entry, 0, shape, limiter));
  const text = readEntryText(asString(row?.text), args, detail, limiter);
  // Under `full` the page hook already cut the entry to the same ceiling and flags it when it did.
  const truncatedByHook = detail === "full" && row?.truncated === true;

  return stripUndefined({
    source: asString(row?.source) ?? "content.injected",
    level: normalizeConsoleLevel(asString(row?.level) ?? method),
    method,
    text,
    args,
    stackTop: asString(row?.stackTop) ?? undefined,
    stack: detail === "full" ? readContentStack(asString(row?.stack)) : undefined,
    truncated: truncatedByHook || limiter.isTruncated() || undefined
  });
}

/** A page-hook stack (V8 `Error.stack` frame lines), held to the frame and entry ceilings. */
function readContentStack(stack: string | undefined): string | undefined {
  if (!stack) {
    return undefined;
  }

  return stack
    .split("\n")
    .slice(0, MAX_FULL_STACK_FRAMES)
    .join("\n")
    .slice(0, MAX_CONSOLE_ENTRY_CHARS);
}

function resolveShape(detail: ConsoleDetail): SerializeShape {
  return detail === "full" ? FULL_SHAPE : COMPACT_SHAPE;
}

function createTextLimiter(detail: ConsoleDetail): TextLimiter {
  if (detail === "compact") {
    return {
      cutString: (value) => compactText(value, 260),
      cutDescription: (value) => compactText(value, 320),
      cutErrorStack: (value) => compactText(value, 500),
      cutText: (value) => compactText(value, 600),
      isTruncated: () => false
    };
  }

  // Per-entry accumulator: every argument string draws from one budget; the text has its own cap.
  let remaining = MAX_CONSOLE_ENTRY_CHARS;
  let truncated = false;
  const cutShared = (value: string): string => {
    const kept = value.slice(0, Math.max(0, remaining));
    remaining -= kept.length;
    truncated ||= kept.length < value.length;
    return kept;
  };

  return {
    cutString: cutShared,
    cutDescription: cutShared,
    cutErrorStack: cutShared,
    cutText: (value) => {
      truncated ||= value.length > MAX_CONSOLE_ENTRY_CHARS;
      return value.slice(0, MAX_CONSOLE_ENTRY_CHARS);
    },
    isTruncated: () => truncated
  };
}

function readEntryText(
  rawText: string | undefined,
  args: unknown[],
  detail: ConsoleDetail,
  limiter: TextLimiter
): string {
  if (rawText === undefined) {
    return formatConsoleText(args, resolveShape(detail), limiter);
  }

  return detail === "full" ? limiter.cutText(rawText) : rawText;
}

function readFullStack(
  detail: ConsoleDetail,
  methodOrLevel: string,
  stackTrace: Record<string, unknown> | null
): string | undefined {
  if (detail !== "full" || !FULL_STACK_METHODS.has(methodOrLevel.toLowerCase())) {
    return undefined;
  }

  return formatV8CallFrames(asArray(stackTrace?.callFrames), MAX_FULL_STACK_FRAMES);
}

function normalizeConsoleLevel(rawLevel: string): ConsoleLevel {
  const value = rawLevel.toLowerCase();

  if (value === "error" || value === "assert") {
    return "error";
  }

  if (value === "warn" || value === "warning") {
    return "warn";
  }

  if (value === "info") {
    return "info";
  }

  if (value === "debug" || value === "trace") {
    return "debug";
  }

  return "log";
}

function normalizeCdpRemoteObject(
  value: unknown,
  shape: SerializeShape,
  limiter: TextLimiter,
  withPreview = false
): unknown {
  const row = asRecord(value);

  if (!row) {
    return sanitizeSerializable(value, 0, shape, limiter);
  }

  if (typeof row.unserializableValue === "string") {
    return row.unserializableValue;
  }

  if ("value" in row) {
    return sanitizeSerializable(row.value, 0, shape, limiter);
  }

  // Under `console: allow`, an object or array argument keeps what CDP's preview shows of it
  // (the page logged `{ ... }`, not the word "Object"). Errors, nodes, dates and the like keep
  // their description: an error's is its whole stack, which the preview cuts.
  const preview =
    withPreview && isPlainPreviewSubtype(row.subtype)
      ? readCdpObjectPreview(asRecord(row.preview), 0, shape, limiter)
      : null;

  if (preview !== null) {
    return preview;
  }

  const description = asString(row.description);

  if (description) {
    return limiter.cutDescription(description);
  }

  return stripUndefined({
    type: asString(row.type),
    subtype: asString(row.subtype),
    className: asString(row.className)
  });
}

/**
 * An object or array built from a CDP `ObjectPreview` (`properties` with string `value`s, nested
 * previews in `valuePreview`); `"…": true` marks a preview CDP cut (`overflow`). Null when the
 * preview carries no properties.
 */
function readCdpObjectPreview(
  preview: Record<string, unknown> | null,
  depth: number,
  shape: SerializeShape,
  limiter: TextLimiter
): unknown {
  const properties = asArray(preview?.properties);

  if (
    !preview ||
    !isPlainPreviewSubtype(preview.subtype) ||
    properties.length === 0 ||
    depth > shape.maxDepth
  ) {
    return null;
  }

  const isArray = preview.subtype === "array";
  const entries = properties
    .slice(0, isArray ? shape.maxArrayItems : shape.maxObjectKeys)
    .flatMap((entry) => {
      const property = asRecord(entry);
      const name = asString(property?.name);

      if (!property || name === undefined) {
        return [];
      }

      const nested = readCdpObjectPreview(
        asRecord(property.valuePreview),
        depth + 1,
        shape,
        limiter
      );
      const text = asString(property.value);
      const value =
        nested ??
        (property.type === "number" && text !== undefined && Number.isFinite(Number(text))
          ? Number(text)
          : property.type === "boolean" && (text === "true" || text === "false")
            ? text === "true"
            : text === undefined
              ? null
              : limiter.cutString(text));
      return [[name, value] as const];
    });

  if (isArray) {
    const items: unknown[] = entries.map(([, value]) => value);
    return preview.overflow === true ? [...items, "…"] : items;
  }

  const output: Record<string, unknown> = Object.fromEntries(entries);
  return preview.overflow === true ? { ...output, "…": true } : output;
}

/** A plain object (no subtype) or an array: the kinds a CDP preview shows in full. */
function isPlainPreviewSubtype(subtype: unknown): boolean {
  return subtype === undefined || subtype === "array";
}

function sanitizeSerializable(
  value: unknown,
  depth: number,
  shape: SerializeShape,
  limiter: TextLimiter
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return limiter.cutString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (depth >= shape.maxDepth) {
    return "[MaxDepth]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, shape.maxArrayItems)
      .map((entry) => sanitizeSerializable(entry, depth + 1, shape, limiter));
  }

  if (value instanceof Error) {
    return stripUndefined({
      name: value.name,
      message: value.message,
      stack: value.stack ? limiter.cutErrorStack(value.stack) : undefined
    });
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, shape.maxObjectKeys)
        .map(([key, entry]) => [key, sanitizeSerializable(entry, depth + 1, shape, limiter)])
    );
  }

  return String(value);
}

function readStackTop(stackTrace: Record<string, unknown> | null): string | undefined {
  if (!stackTrace) {
    return undefined;
  }

  const frames = asArray(stackTrace.callFrames);
  const frame = asRecord(frames[0]);

  if (!frame) {
    return undefined;
  }

  const url = sanitizeOptionalUrl(asString(frame.url)) ?? "(anonymous)";
  const line = asFiniteNumber(frame.lineNumber);
  const col = asFiniteNumber(frame.columnNumber);
  // CDP reports anonymous functions as "", which would leave the `fn @ url` shape without a name.
  const functionName = asString(frame.functionName) || "(anonymous)";

  return `${functionName} @ ${url}:${line ?? 0}:${col ?? 0}`;
}

function formatConsoleText(args: unknown[], shape: SerializeShape, limiter: TextLimiter): string {
  if (args.length === 0) {
    return "";
  }

  const parts = args
    .slice(0, shape.maxTextArgs)
    .map((entry) => stringifyConsoleArg(entry))
    .filter((entry) => entry.length > 0);

  return limiter.cutText(parts.join(" "));
}

function stringifyConsoleArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
