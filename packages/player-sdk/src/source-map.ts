import {
  AnyMap,
  originalPositionFor,
  sourceContentFor,
  type SectionedSourceMapInput,
  type TraceMap
} from "@jridgewell/trace-mapping";

/** Largest source map accepted by default (bytes of JSON). */
export const DEFAULT_SOURCE_MAP_MAX_BYTES = 32 * 1024 * 1024;

const MAX_SECTIONS = 1_000;
const MAX_SECTION_DEPTH = 2;
const MAX_SOURCES = 100_000;
const MAX_NAMES = 1_000_000;
const XSSI_PREFIX = ")]}'";
const DEFAULT_SNIPPET_CONTEXT_LINES = 2;
const MAX_SNIPPET_CONTEXT_LINES = 10;
const MAX_SNIPPET_LINE_CHARS = 240;

/** A source map that failed validation or decoding. */
export class SourceMapError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceMapError";
  }
}

/** A decoded, validated source map. */
export type ParsedSourceMap = {
  readonly trace: TraceMap;
  /** Bytes of JSON the map was parsed from. */
  readonly size: number;
};

export type ParseSourceMapOptions = {
  /** URL the map was loaded from; relative `sources` resolve against it. */
  mapUrl?: string;
  maxBytes?: number;
};

/** An original position. `line` and `column` are 1-based. */
export type OriginalPosition = {
  source: string;
  line: number;
  column: number;
  /** Identifier recorded at this position (for a call site: the callee's original name). */
  name?: string;
};

export type SourceSnippet = {
  /** 1-based line number of `lines[0]`. */
  startLine: number;
  /** 1-based line number of the mapped position. */
  highlightLine: number;
  lines: string[];
};

/**
 * Validates and decodes an untrusted source map (v3, regular or indexed with `sections`).
 * The `)]}'` XSSI prefix is accepted. Throws `SourceMapError` when the input is too large, is
 * not JSON, or does not look like a source map.
 */
export function parseSourceMap(
  input: string | Uint8Array,
  options: ParseSourceMapOptions = {}
): ParsedSourceMap {
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_MAP_MAX_BYTES;
  const size = typeof input === "string" ? utf8Length(input) : input.byteLength;

  if (size > maxBytes) {
    throw new SourceMapError(`Source map is ${size} bytes; the limit is ${maxBytes}.`);
  }

  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  let json: unknown;

  try {
    json = JSON.parse(stripXssiPrefix(text));
  } catch {
    throw new SourceMapError("Source map is not valid JSON.");
  }

  assertSourceMapShape(json, 0);

  try {
    return {
      trace: new AnyMap(json as SectionedSourceMapInput, options.mapUrl),
      size
    };
  } catch (error) {
    throw new SourceMapError(
      `Source map could not be decoded: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Original position for a 1-based generated line and column (as printed in stack traces).
 * Falls back to the closest mapping to the left on the same line; `null` when there is none.
 */
export function lookupOriginalPosition(
  map: ParsedSourceMap,
  line: number,
  column: number
): OriginalPosition | null {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
    return null;
  }

  const position = originalPositionFor(map.trace, { line, column: column - 1 });

  if (position.source === null || position.line === null) {
    return null;
  }

  return {
    source: position.source,
    line: position.line,
    column: position.column + 1,
    ...(position.name ? { name: position.name } : {})
  };
}

/** Lines of `sourcesContent` around a position; `null` when the map has no content for it. */
export function readSourceSnippet(
  map: ParsedSourceMap,
  position: Pick<OriginalPosition, "source" | "line">,
  contextLines = DEFAULT_SNIPPET_CONTEXT_LINES
): SourceSnippet | null {
  const content = sourceContentFor(map.trace, position.source);

  if (typeof content !== "string") {
    return null;
  }

  const context = Math.max(0, Math.min(MAX_SNIPPET_CONTEXT_LINES, Math.floor(contextLines)));
  const lines = content.split(/\r?\n/u);
  const index = position.line - 1;

  if (index < 0 || index >= lines.length) {
    return null;
  }

  const start = Math.max(0, index - context);
  const end = Math.min(lines.length, index + context + 1);

  return {
    startLine: start + 1,
    highlightLine: position.line,
    lines: lines.slice(start, end).map((line) => truncate(line, MAX_SNIPPET_LINE_CHARS))
  };
}

function assertSourceMapShape(value: unknown, depth: number): void {
  const map = asRecord(value);

  if (!map || map.version !== 3) {
    throw new SourceMapError("Not a version 3 source map.");
  }

  if (Array.isArray(map.sections)) {
    assertSections(map.sections, depth);
    return;
  }

  if (typeof map.mappings !== "string") {
    throw new SourceMapError("Source map has no mappings.");
  }

  if (!isStringOrNullArray(map.sources, MAX_SOURCES)) {
    throw new SourceMapError("Source map has an invalid sources list.");
  }

  if (map.names !== undefined && !isStringOrNullArray(map.names, MAX_NAMES)) {
    throw new SourceMapError("Source map has an invalid names list.");
  }

  if (map.sourcesContent !== undefined && !isStringOrNullArray(map.sourcesContent, MAX_SOURCES)) {
    throw new SourceMapError("Source map has an invalid sourcesContent list.");
  }

  if (map.sourceRoot !== undefined && typeof map.sourceRoot !== "string") {
    throw new SourceMapError("Source map has an invalid sourceRoot.");
  }
}

function assertSections(sections: unknown[], depth: number): void {
  if (depth >= MAX_SECTION_DEPTH || sections.length > MAX_SECTIONS) {
    throw new SourceMapError("Indexed source map is nested too deeply or has too many sections.");
  }

  for (const entry of sections) {
    const section = asRecord(entry);
    const offset = asRecord(section?.offset);

    if (
      !section ||
      !offset ||
      !Number.isSafeInteger(offset.line) ||
      !Number.isSafeInteger(offset.column)
    ) {
      throw new SourceMapError("Indexed source map has an invalid section offset.");
    }

    // Sections that point to another URL would need a fetch; only embedded maps are supported.
    if (section.map === undefined) {
      throw new SourceMapError("Indexed source map sections must embed their map.");
    }

    assertSourceMapShape(section.map, depth + 1);
  }
}

function isStringOrNullArray(value: unknown, maxLength: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((entry) => entry === null || typeof entry === "string")
  );
}

function stripXssiPrefix(text: string): string {
  if (!text.startsWith(XSSI_PREFIX)) {
    return text;
  }

  const newline = text.indexOf("\n");
  return newline >= 0 ? text.slice(newline + 1) : "";
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
