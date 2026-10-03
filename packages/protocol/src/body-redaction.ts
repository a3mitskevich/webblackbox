/** Default replacement written in place of masked body values. */
export const BODY_REDACTION_TOKEN = "[REDACTED]";

export type BodyTextRedactionResult = {
  value: string;
  redacted: boolean;
};

export type BodyBytesRedactionResult = {
  bytes: Uint8Array;
  redacted: boolean;
};

export type BodyBytesRedactionOptions = {
  mimeType?: string;
  redactionToken?: string;
};

type Range = {
  start: number;
  end: number;
};

// Keys are short; bounding the scan keeps the text scanner linear on pathological input.
const MAX_KEY_LENGTH = 128;
const KEY_DELIMITERS = new Set([..." \t\r\n\f\v\"'`=:&;,?#<>{}()/\\|"]);
const KEY_CLOSERS = new Set(['"', "'", "`", "\\"]);
const MAX_KEY_CLOSERS = 3;
const EQUALS_VALUE_DELIMITERS = new Set([..." \t\r\n\f\v\"'`&;,#<>{}[]()\\"]);
const COLON_VALUE_DELIMITERS = new Set([..."\r\n\"'`&;,<>{}[]\\"]);
const QUOTES = new Set(['"', "'", "`"]);
const LATIN1_CHUNK_SIZE = 8192;

/**
 * Masks values that follow keys matching any of `patterns` (case-insensitive substring match).
 * Handles JSON (nested objects/arrays), form-urlencoded and query-like strings, XML elements,
 * and `key: value` / `key=value` plain text. Keys stay readable; only values are replaced.
 */
export function redactBodyText(
  value: string,
  patterns: readonly string[],
  redactionToken: string = BODY_REDACTION_TOKEN
): BodyTextRedactionResult {
  const normalizedPatterns = normalizePatterns(patterns);

  if (normalizedPatterns.length === 0 || value.length === 0) {
    return { value, redacted: false };
  }

  const jsonResult = redactJsonText(value, normalizedPatterns, redactionToken);

  if (jsonResult) {
    return jsonResult;
  }

  return redactPlainText(value, normalizedPatterns, redactionToken);
}

/**
 * Redacts a decoded (e.g. base64) body. Textual MIME types are decoded as UTF-8, or byte-preserving
 * latin1 when not valid UTF-8; bodies without a MIME type are only redacted when they are valid
 * UTF-8. Binary MIME types are returned untouched.
 */
export function redactBodyBytes(
  bytes: Uint8Array,
  patterns: readonly string[],
  options: BodyBytesRedactionOptions = {}
): BodyBytesRedactionResult {
  const unchanged: BodyBytesRedactionResult = { bytes, redacted: false };
  const mimeType = options.mimeType?.trim().toLowerCase();

  if (bytes.byteLength === 0 || normalizePatterns(patterns).length === 0) {
    return unchanged;
  }

  if (mimeType && !isTextualMimeType(mimeType)) {
    return unchanged;
  }

  const utf8Text = decodeUtf8Strict(bytes);

  if (utf8Text === null && !mimeType) {
    return unchanged;
  }

  const text = utf8Text ?? decodeLatin1(bytes);
  const redaction = redactBodyText(text, patterns, options.redactionToken ?? BODY_REDACTION_TOKEN);

  if (!redaction.redacted) {
    return unchanged;
  }

  return {
    bytes:
      utf8Text !== null ? new TextEncoder().encode(redaction.value) : encodeLatin1(redaction.value),
    redacted: true
  };
}

/** Returns whether a (lowercase) MIME type carries text that body redaction can inspect. */
export function isTextualMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.includes("ecmascript") ||
    mimeType.includes("x-www-form-urlencoded")
  );
}

function normalizePatterns(patterns: readonly string[]): string[] {
  const output: string[] = [];

  for (const pattern of patterns) {
    const normalized = pattern.trim().toLowerCase();

    if (normalized && !output.includes(normalized)) {
      output.push(normalized);
    }
  }

  return output;
}

function isSensitiveName(name: string, patterns: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

function redactJsonText(
  value: string,
  patterns: readonly string[],
  token: string
): BodyTextRedactionResult | null {
  const trimmed = value.trimStart();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  const result = redactJsonValue(parsed, patterns, token);

  if (!result.redacted) {
    return { value, redacted: false };
  }

  return {
    value: JSON.stringify(result.value, null, value.includes("\n") ? 2 : undefined),
    redacted: true
  };
}

function redactJsonValue(
  value: unknown,
  patterns: readonly string[],
  token: string
): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    return redactPlainText(value, patterns, token);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => redactJsonValue(item, patterns, token));
    return {
      value: items.map((item) => item.value),
      redacted: items.some((item) => item.redacted)
    };
  }

  if (value === null || typeof value !== "object") {
    return { value, redacted: false };
  }

  let redacted = false;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (isSensitiveName(key, patterns)) {
      if (entry === null || entry === "") {
        return [key, entry] as const;
      }

      redacted = true;
      return [key, token] as const;
    }

    const nested = redactJsonValue(entry, patterns, token);
    redacted = redacted || nested.redacted;
    return [key, nested.value] as const;
  });

  return { value: Object.fromEntries(entries), redacted };
}

function redactPlainText(
  value: string,
  patterns: readonly string[],
  token: string
): BodyTextRedactionResult {
  const matches = findPatternMatches(value, patterns);
  const ranges: Range[] = [];
  let maskedUntil = -1;

  for (const match of matches) {
    if (match.start < maskedUntil) {
      continue;
    }

    const range = resolveValueRange(value, match);

    if (range) {
      ranges.push(range);
      maskedUntil = range.end;
    }
  }

  if (ranges.length === 0) {
    return { value, redacted: false };
  }

  let output = "";
  let cursor = 0;

  for (const range of ranges) {
    output += value.slice(cursor, range.start) + token;
    cursor = range.end;
  }

  return { value: output + value.slice(cursor), redacted: true };
}

function findPatternMatches(value: string, patterns: readonly string[]): Range[] {
  const matches: Range[] = [];

  for (const pattern of patterns) {
    const regex = new RegExp(escapeRegExp(pattern), "gi");

    for (const match of value.matchAll(regex)) {
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return matches.sort((left, right) => left.start - right.start || left.end - right.end);
}

function resolveValueRange(value: string, match: Range): Range | null {
  const keyStart = scanKeyBoundary(value, match.start, -1);
  const keyEnd = scanKeyBoundary(value, match.end, 1);

  if (keyStart === null || keyEnd === null) {
    return null;
  }

  if (keyStart > 0 && value[keyStart - 1] === "<") {
    return resolveXmlElementValue(value, keyEnd);
  }

  let cursor = keyEnd;
  let closers = 0;

  while (closers < MAX_KEY_CLOSERS && KEY_CLOSERS.has(value[cursor] ?? "")) {
    cursor += 1;
    closers += 1;
  }

  cursor = skipInlineWhitespace(value, cursor);
  const separator = value[cursor];

  if (separator !== ":" && separator !== "=") {
    return null;
  }

  return resolveSeparatedValue(value, skipInlineWhitespace(value, cursor + 1), separator);
}

function scanKeyBoundary(value: string, from: number, direction: 1 | -1): number | null {
  let cursor = from;

  for (let steps = 0; steps <= MAX_KEY_LENGTH; steps += 1) {
    const next = direction === 1 ? value[cursor] : value[cursor - 1];

    if (next === undefined || KEY_DELIMITERS.has(next)) {
      return cursor;
    }

    cursor += direction;
  }

  return null;
}

function resolveSeparatedValue(value: string, start: number, separator: string): Range | null {
  const first = value[start];
  const second = value[start + 1];

  if (first === "\\" && second !== undefined && QUOTES.has(second)) {
    const closing = value.indexOf(`\\${second}`, start + 2);
    return nonEmptyRange(start + 2, closing === -1 ? value.length : closing);
  }

  if (first !== undefined && QUOTES.has(first)) {
    return nonEmptyRange(start + 1, findClosingQuote(value, start + 1, first));
  }

  const delimiters = separator === "=" ? EQUALS_VALUE_DELIMITERS : COLON_VALUE_DELIMITERS;
  let end = start;

  while (end < value.length && !delimiters.has(value.charAt(end))) {
    end += 1;
  }

  // `key: value` runs to the end of the line; do not swallow trailing spaces.
  while (end > start && /\s/.test(value.charAt(end - 1))) {
    end -= 1;
  }

  return nonEmptyRange(start, end);
}

function resolveXmlElementValue(value: string, keyEnd: number): Range | null {
  const tagEnd = value.indexOf(">", keyEnd);

  if (tagEnd === -1 || value[tagEnd - 1] === "/") {
    return null;
  }

  const nextTag = value.indexOf("<", keyEnd);

  if (nextTag !== -1 && nextTag < tagEnd) {
    return null;
  }

  const closing = value.indexOf("<", tagEnd + 1);
  const range = nonEmptyRange(tagEnd + 1, closing === -1 ? value.length : closing);

  if (!range || value.slice(range.start, range.end).trim().length === 0) {
    return null;
  }

  return range;
}

function findClosingQuote(value: string, from: number, quote: string): number {
  for (let index = from; index < value.length; index += 1) {
    const char = value[index];

    if (char === "\\") {
      index += 1;
      continue;
    }

    if (char === quote) {
      return index;
    }
  }

  return value.length;
}

function skipInlineWhitespace(value: string, from: number): number {
  let cursor = from;

  while (value[cursor] === " " || value[cursor] === "\t") {
    cursor += 1;
  }

  return cursor;
}

function nonEmptyRange(start: number, end: number): Range | null {
  return end > start ? { start, end } : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  let output = "";

  for (let offset = 0; offset < bytes.byteLength; offset += LATIN1_CHUNK_SIZE) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + LATIN1_CHUNK_SIZE));
  }

  return output;
}

function encodeLatin1(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);

  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }

  return bytes;
}
