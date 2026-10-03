import { z } from "zod";

/** Where a script's source map reference was found. */
export const SCRIPT_SOURCE_MAP_ORIGINS = ["cdp", "header", "comment"] as const;

export type ScriptSourceMapOrigin = (typeof SCRIPT_SOURCE_MAP_ORIGINS)[number];

/** Longest script or source map URL kept in a `sys.script` event. */
export const SCRIPT_URL_MAX_LENGTH = 2_048;

/**
 * Payload of a `sys.script` event: one script and the source map it points to.
 *
 * Locations are stored as origin + path (query and fragment dropped) under keys that do not end
 * in `url`: the recorder route-templates `*url` fields, which would turn content-hashed bundle
 * names (`main.4f3a9c2b.js`) into `:id` and make frames unmatchable. The same paths already
 * appear verbatim in recorded stack traces.
 */
export type ScriptSourceMapData = {
  /** Script location (origin + path). */
  script: string;
  /** Source map location (origin + path) resolved against `script`; absent for inline maps. */
  sourceMap?: string;
  /** The script carries its map inline as a `data:` URL (never stored in the event). */
  inlineMap?: boolean;
  origin: ScriptSourceMapOrigin;
  scriptId?: string;
  /** Content hash reported by the debugger (not a WebBlackbox blob hash). */
  hash?: string;
  length?: number;
  isModule?: boolean;
  /** Embedded source map blob (follow-up event once the map was fetched at record time). */
  map?: { contentHash: string; size: number };
  /** Why embedding the map failed (follow-up event). */
  mapError?: string;
};

export const scriptSourceMapDataSchema = z
  .object({
    script: z.string().min(1).max(SCRIPT_URL_MAX_LENGTH),
    sourceMap: z.string().min(1).max(SCRIPT_URL_MAX_LENGTH).optional(),
    inlineMap: z.boolean().optional(),
    origin: z.enum(SCRIPT_SOURCE_MAP_ORIGINS),
    scriptId: z.string().min(1).max(128).optional(),
    hash: z.string().min(1).max(128).optional(),
    length: z.number().int().nonnegative().optional(),
    isModule: z.boolean().optional(),
    map: z
      .object({
        contentHash: z.string().min(1),
        size: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    mapError: z.string().min(1).max(200).optional()
  })
  .strict();

const SOURCE_MAP_HEADER_NAMES = ["sourcemap", "x-sourcemap"] as const;
const SOURCE_MAPPING_URL_PATTERN =
  /^[ \t]*\/\/[#@][ \t]*sourceMappingURL[ \t]*=[ \t]*(\S+)[ \t]*$/u;
/** Only the tail of a script is searched; the reference is the last such comment. */
const SOURCE_MAPPING_URL_TAIL_CHARS = 8 * 1024;

/** `SourceMap` (or legacy `X-SourceMap`) response header value; names match case-insensitively. */
export function readSourceMapHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }

  const entries = Object.entries(headers as Record<string, unknown>);

  for (const name of SOURCE_MAP_HEADER_NAMES) {
    const entry = entries.find(([key]) => key.toLowerCase() === name);
    const value = typeof entry?.[1] === "string" ? entry[1].trim() : "";

    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * The URL in the script's trailing `//# sourceMappingURL=` comment (or the legacy `//@` form).
 * Only the last matching line in the final 8 KiB counts.
 */
export function extractSourceMappingUrl(scriptText: string): string | undefined {
  const lines = scriptText.slice(-SOURCE_MAPPING_URL_TAIL_CHARS).split(/\r?\n/u);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = SOURCE_MAPPING_URL_PATTERN.exec(lines[index] ?? "");

    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * Origin + path of an http(s) URL (query, fragment and credentials dropped), capped at
 * `SCRIPT_URL_MAX_LENGTH`; `null` for anything else.
 */
export function toScriptLocation(value: string): string | null {
  try {
    const url = new URL(value.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const location = `${url.origin}${url.pathname}`;

    return location.length <= SCRIPT_URL_MAX_LENGTH ? location : null;
  } catch {
    return null;
  }
}

export type ResolvedSourceMapReference =
  | { kind: "remote"; url: string }
  | { kind: "inline"; url: string };

/**
 * Resolves a source map reference against its script URL. Returns `null` for references that
 * are neither http(s) nor inline `data:` maps.
 */
export function resolveSourceMapReference(
  reference: string,
  scriptUrl: string
): ResolvedSourceMapReference | null {
  const trimmed = reference.trim();

  if (/^data:/iu.test(trimmed)) {
    return { kind: "inline", url: trimmed };
  }

  try {
    const resolved = new URL(trimmed, scriptUrl);

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    return { kind: "remote", url: resolved.href };
  } catch {
    return null;
  }
}
