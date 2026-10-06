import {
  resolveSourceMapReference,
  scriptSourceMapDataSchema,
  SCRIPT_SOURCE_MAP_ORIGINS,
  toScriptLocation,
  type ScriptSourceMapData,
  type ScriptSourceMapOrigin
} from "@webblackbox/protocol";

import {
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  compactText,
  stripUndefined
} from "./normalizer-utils.js";

const MAX_ID_LENGTH = 128;
const MAX_MAP_ERROR_LENGTH = 200;

/**
 * Turns a raw script record (`{ url, sourceMapUrl, origin, ... }` from the CDP debugger or the
 * lite scanner) into a `sys.script` payload. Only http(s) scripts that reference a source map
 * are kept; locations lose their query and fragment; inline `data:` maps are flagged, never
 * copied. Returns `null` for anything else.
 */
export function normalizeScriptSourceMapPayload(payload: unknown): ScriptSourceMapData | null {
  const row = asRecord(payload);
  const rawUrl = asString(row?.url);
  const script = rawUrl ? toScriptLocation(rawUrl) : null;
  const origin = readOrigin(row?.origin);

  if (!row || !rawUrl || !script || !origin) {
    return null;
  }

  const reference = asString(row.sourceMapUrl);
  const resolved = reference ? resolveSourceMapReference(reference, rawUrl) : null;
  const sourceMap = resolved?.kind === "remote" ? toScriptLocation(resolved.url) : null;
  const inlineMap = resolved?.kind === "inline";

  if (!sourceMap && !inlineMap) {
    return null;
  }

  const map = asRecord(row.map);
  const contentHash = asString(map?.contentHash);
  const mapSize = asFiniteNumber(map?.size);
  const mapError = asString(row.mapError);
  const candidate = stripUndefined({
    script,
    sourceMap: sourceMap ?? undefined,
    inlineMap: inlineMap || undefined,
    origin,
    scriptId: readBoundedId(row.scriptId),
    hash: readBoundedId(row.hash),
    length: readNonNegativeInt(row.length),
    isModule: asBoolean(row.isModule),
    map:
      contentHash && mapSize !== null && mapSize >= 0
        ? { contentHash, size: Math.round(mapSize) }
        : undefined,
    mapError: mapError ? compactText(mapError, MAX_MAP_ERROR_LENGTH) : undefined
  });
  const parsed = scriptSourceMapDataSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
}

function readOrigin(value: unknown): ScriptSourceMapOrigin | null {
  return typeof value === "string" &&
    (SCRIPT_SOURCE_MAP_ORIGINS as readonly string[]).includes(value)
    ? (value as ScriptSourceMapOrigin)
    : null;
}

function readBoundedId(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;

  return typeof text === "string" && text.length > 0 && text.length <= MAX_ID_LENGTH
    ? text
    : undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);

  return numeric !== null && numeric >= 0 ? Math.round(numeric) : undefined;
}
