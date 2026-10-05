import { recordedUrl } from "./url-recording.js";

export function normalizeHeaderRecord(value: unknown): Record<string, string> | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const output: Record<string, string> = {};

  for (const [key, entry] of Object.entries(row).slice(0, 64)) {
    if (typeof entry === "string") {
      output[key.toLowerCase()] = compactText(entry, 500);
      continue;
    }

    if (typeof entry === "number" || typeof entry === "boolean") {
      output[key.toLowerCase()] = String(entry);
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

export function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      output[key] = entry;
    }
  }

  return output;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function sanitizeOptionalUrl(value: string | undefined): string | undefined {
  return value ? recordedUrl(value) : undefined;
}

export function compactText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

export function omitKeys(
  row: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

/**
 * Formats CDP call frames (0-based positions) as V8 `Error.stack` lines (`    at fn (url:line:col)`,
 * 1-based), the text shape stack parsers and the source-map symbolicator read.
 */
export function formatV8CallFrames(callFrames: unknown[], maxFrames: number): string | undefined {
  const lines = callFrames
    .slice(0, maxFrames)
    .map((entry) => asRecord(entry))
    .filter((frame): frame is Record<string, unknown> => frame !== null)
    .map((frame) => {
      const functionName = asString(frame.functionName) || "(anonymous)";
      const url = sanitizeOptionalUrl(asString(frame.url)) ?? "(unknown)";
      return `    at ${functionName} (${url}:${toOneBased(frame.lineNumber) ?? 0}:${toOneBased(frame.columnNumber) ?? 0})`;
    });

  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function toOneBased(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  return numeric === null ? undefined : numeric + 1;
}
