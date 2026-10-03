import {
  readSourceMapHeader,
  resolveSourceMapReference,
  toScriptLocation,
  type ScriptSourceMapOrigin
} from "@webblackbox/protocol";

/** Raw recorder type of script → source map records (normalized to `sys.script`). */
export const SCRIPT_RAW_TYPE = "script";
/** `Debugger.enable` keeps at most this many bytes of otherwise unreferenced script sources. */
export const DEBUGGER_SCRIPT_CACHE_BYTES = 1_000_000;
export const SOURCE_MAP_FETCH_TIMEOUT_MS = 10_000;
/** Source maps fetched at the same time per session. */
export const SOURCE_MAP_FETCH_CONCURRENCY = 2;

const DEFAULT_LIMITS: ScriptSourceMapLimits = {
  maxScripts: 500,
  maxEmbeddedMaps: 200,
  maxEmbeddedBytes: 64 * 1024 * 1024
};
const XSSI_PREFIX = ")]}'";
const MAX_ID_LENGTH = 128;

/** A script and its source map reference, with full URLs (normalized by the recorder). */
export type RawScriptRecord = {
  url: string;
  sourceMapUrl: string;
  origin: ScriptSourceMapOrigin;
  scriptId?: string;
  hash?: string;
  length?: number;
  isModule?: boolean;
};

export type ScriptSourceMapLimits = {
  /** Script records per session. */
  maxScripts: number;
  /** Maps embedded per session. */
  maxEmbeddedMaps: number;
  /** Bytes of embedded maps per session. */
  maxEmbeddedBytes: number;
};

/** Record for a `Debugger.scriptParsed` event; `null` unless it is an http(s) script with a map. */
export function scriptRecordFromScriptParsed(params: unknown): RawScriptRecord | null {
  const row = asRecord(params);
  const url = asString(row?.url);
  const sourceMapUrl = asString(row?.sourceMapURL)?.trim();

  if (!row || !url || !sourceMapUrl || !toScriptLocation(url)) {
    return null;
  }

  const scriptId = asBoundedId(row.scriptId);
  const hash = asBoundedId(row.hash);
  const length = typeof row.length === "number" && row.length >= 0 ? row.length : undefined;

  return {
    url,
    sourceMapUrl,
    origin: "cdp",
    ...(scriptId ? { scriptId } : {}),
    ...(hash ? { hash } : {}),
    ...(length !== undefined ? { length } : {}),
    ...(typeof row.isModule === "boolean" ? { isModule: row.isModule } : {})
  };
}

/**
 * Record for a `Network.responseReceived` of a script carrying a `SourceMap` / `X-SourceMap`
 * header; `null` otherwise.
 */
export function scriptRecordFromResponse(params: unknown): RawScriptRecord | null {
  const row = asRecord(params);
  const response = asRecord(row?.response);
  const url = asString(response?.url);

  if (row?.type !== "Script" || !url || !toScriptLocation(url)) {
    return null;
  }

  const sourceMapUrl = readSourceMapHeader(response?.headers);

  return sourceMapUrl ? { url, sourceMapUrl, origin: "header" } : null;
}

/**
 * Per-session bookkeeping: each (script, map) pair is recorded once, each map is embedded once,
 * and both are capped so a page that keeps loading bundles cannot grow the archive without bound.
 */
export class ScriptSourceMapTracker {
  private readonly recorded = new Set<string>();

  private readonly embedded = new Set<string>();

  private embeddedBytes = 0;

  private readonly limits: ScriptSourceMapLimits;

  public constructor(limits: Partial<ScriptSourceMapLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** `true` the first time a (script, map) pair is seen while under the script cap. */
  public markRecorded(record: RawScriptRecord): boolean {
    const key = `${toScriptLocation(record.url) ?? record.url}\n${mapKey(record)}`;

    if (this.recorded.has(key) || this.recorded.size >= this.limits.maxScripts) {
      return false;
    }

    this.recorded.add(key);
    return true;
  }

  /** `true` the first time a map is about to be embedded while under the map count cap. */
  public reserveEmbed(record: RawScriptRecord): boolean {
    const key = mapKey(record);

    if (this.embedded.has(key) || this.embedded.size >= this.limits.maxEmbeddedMaps) {
      return false;
    }

    this.embedded.add(key);
    return true;
  }

  public remainingEmbedBytes(): number {
    return Math.max(0, this.limits.maxEmbeddedBytes - this.embeddedBytes);
  }

  /**
   * Counts a fetched map against the session byte budget; `false` (nothing counted) when it no
   * longer fits. Maps are fetched concurrently, so the budget is charged once the size is known.
   */
  public tryAddEmbeddedBytes(bytes: number): boolean {
    if (bytes > this.remainingEmbedBytes()) {
      return false;
    }

    this.embeddedBytes += bytes;
    return true;
  }
}

/**
 * Runs at most `limit` tasks at a time; the rest wait in arrival order. Map fetches go through
 * this instead of the session queue so a slow map server never stalls capture work.
 */
export function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const waiting: Array<() => void> = [];
  let running = 0;

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) {
      // The finishing task hands its slot over, so `running` stays at the limit.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();

      if (next) {
        next();
      } else {
        running -= 1;
      }
    }
  };
}

export type SourceMapFetchResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

type FetchLike = (
  input: string,
  init: { credentials: "include"; signal: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Loads a script's source map for embedding: decodes inline `data:` maps or fetches http(s)
 * maps (page cookies included, as DevTools would), capped at `maxBytes`, and checks the result
 * is a version 3 source map. Never throws.
 */
export async function loadSourceMapForEmbedding(
  record: RawScriptRecord,
  options: { maxBytes: number; fetch?: FetchLike; timeoutMs?: number }
): Promise<SourceMapFetchResult> {
  const reference = resolveSourceMapReference(record.sourceMapUrl, record.url);

  if (!reference) {
    return { ok: false, error: "unsupported source map URL" };
  }

  if (options.maxBytes <= 0) {
    return { ok: false, error: "session source map budget exhausted" };
  }

  try {
    const bytes =
      reference.kind === "inline"
        ? decodeDataUrl(reference.url, options.maxBytes)
        : await fetchCapped(
            reference.url,
            options.maxBytes,
            options.fetch ?? (globalThis.fetch as unknown as FetchLike),
            options.timeoutMs ?? SOURCE_MAP_FETCH_TIMEOUT_MS
          );

    return isSourceMapJson(bytes)
      ? { ok: true, bytes }
      : { ok: false, error: "response is not a source map" };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function mapKey(record: RawScriptRecord): string {
  const reference = resolveSourceMapReference(record.sourceMapUrl, record.url);
  return reference?.kind === "remote" ? reference.url : `inline:${record.url}`;
}

function decodeDataUrl(url: string, maxBytes: number): Uint8Array {
  const comma = url.indexOf(",");

  if (comma < 0) {
    throw new Error("malformed data URL");
  }

  const meta = url.slice(5, comma).toLowerCase();
  const data = url.slice(comma + 1);
  const isBase64 = meta.endsWith(";base64");
  // base64 inflates by 4/3; reject before decoding anything that cannot fit.
  const estimated = isBase64 ? Math.floor((data.length * 3) / 4) : data.length;

  if (estimated > maxBytes) {
    throw new Error(`inline source map exceeds ${maxBytes} bytes`);
  }

  const bytes = isBase64
    ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data));

  if (bytes.byteLength > maxBytes) {
    throw new Error(`inline source map exceeds ${maxBytes} bytes`);
  }

  return bytes;
}

async function fetchCapped(
  url: string,
  maxBytes: number,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { credentials: "include", signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`source map exceeds ${maxBytes} bytes`);
    }

    return await readBodyCapped(response, maxBytes, controller);
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(
  response: Awaited<ReturnType<FetchLike>>,
  maxBytes: number,
  controller: AbortController
): Promise<Uint8Array> {
  const reader = response.body?.getReader();

  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength > maxBytes) {
      throw new Error(`source map exceeds ${maxBytes} bytes`);
    }

    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      controller.abort();
      throw new Error(`source map exceeds ${maxBytes} bytes`);
    }

    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function isSourceMapJson(bytes: Uint8Array): boolean {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  if (text.startsWith(XSSI_PREFIX)) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }

  try {
    const map = asRecord(JSON.parse(text));
    return map?.version === 3 && (typeof map.mappings === "string" || Array.isArray(map.sections));
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timed out" : error.message;
  }

  return String(error);
}

function asBoundedId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
