import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  compactText,
  sanitizeOptionalUrl,
  stripUndefined
} from "./normalizer-utils.js";

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export function normalizeCdpConsolePayload(
  rawType: string,
  payload: unknown
): Record<string, unknown> {
  if (rawType === "Log.entryAdded") {
    const row = asRecord(payload);
    const entry = asRecord(row?.entry);
    const text = asString(entry?.text) ?? "";
    const method = asString(entry?.source) ?? "log.entry";

    return stripUndefined({
      source: "cdp.log",
      level: normalizeConsoleLevel(asString(entry?.level) ?? method),
      method,
      text: text || "(empty log entry)",
      args: text ? [text] : [],
      stackTop: readStackTop(asRecord(entry?.stackTrace)),
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
  const args = asArray(row?.args).map((entry) => normalizeCdpRemoteObject(entry));
  const text = asString(row?.text) ?? formatConsoleText(args);

  return stripUndefined({
    source: "cdp.runtime",
    level: normalizeConsoleLevel(method),
    method,
    text,
    args,
    stackTop: readStackTop(asRecord(row?.stackTrace)),
    executionContextId: asFiniteNumber(row?.executionContextId) ?? undefined,
    timestamp: asFiniteNumber(row?.timestamp) ?? undefined
  });
}

export function normalizeContentConsolePayload(payload: unknown): Record<string, unknown> {
  const row = asRecord(payload);
  const method = asString(row?.method) ?? "log";
  const args = asArray(row?.args).map((entry) => sanitizeSerializable(entry, 0));
  const text = asString(row?.text) ?? formatConsoleText(args);

  return stripUndefined({
    source: asString(row?.source) ?? "content.injected",
    level: normalizeConsoleLevel(asString(row?.level) ?? method),
    method,
    text,
    args,
    stackTop: asString(row?.stackTop) ?? undefined
  });
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

function normalizeCdpRemoteObject(value: unknown): unknown {
  const row = asRecord(value);

  if (!row) {
    return sanitizeSerializable(value, 0);
  }

  if (typeof row.unserializableValue === "string") {
    return row.unserializableValue;
  }

  if ("value" in row) {
    return sanitizeSerializable(row.value, 0);
  }

  const description = asString(row.description);

  if (description) {
    return compactText(description, 320);
  }

  return stripUndefined({
    type: asString(row.type),
    subtype: asString(row.subtype),
    className: asString(row.className)
  });
}

function sanitizeSerializable(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return compactText(value, 260);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (depth >= 4) {
    return "[MaxDepth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => sanitizeSerializable(entry, depth + 1));
  }

  if (value instanceof Error) {
    return stripUndefined({
      name: value.name,
      message: value.message,
      stack: value.stack ? compactText(value.stack, 500) : undefined
    });
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      output[key] = sanitizeSerializable(entry, depth + 1);
    }

    return output;
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
  const functionName = asString(frame.functionName) ?? "(anonymous)";

  return `${functionName} @ ${url}:${line ?? 0}:${col ?? 0}`;
}

function formatConsoleText(args: unknown[]): string {
  if (args.length === 0) {
    return "";
  }

  const parts = args
    .slice(0, 8)
    .map((entry) => stringifyConsoleArg(entry))
    .filter((entry) => entry.length > 0);

  return compactText(parts.join(" "), 600);
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
