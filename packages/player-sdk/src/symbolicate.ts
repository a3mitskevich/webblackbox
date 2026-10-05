import {
  scriptSourceMapDataSchema,
  type WebBlackboxEvent,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import {
  DEFAULT_SOURCE_MAP_MAX_BYTES,
  lookupOriginalPosition,
  parseSourceMap,
  readSourceSnippet,
  SourceMapError,
  type OriginalPosition,
  type ParsedSourceMap,
  type SourceSnippet
} from "./source-map.js";
import {
  parseCdpStackTop,
  parseStackLine,
  parseStackTrace,
  stripFrameUrl,
  type StackFrame
} from "./stack-trace.js";

/** What the archive recorded about one script's source map (`sys.script` events merged). */
export type ScriptSourceMapEntry = {
  /** Script location: origin + path. */
  script: string;
  sourceMap?: string;
  inlineMap: boolean;
  /** Blob hash of the map embedded at record time. */
  mapBlobHash?: string;
  /** Why embedding failed at record time. */
  mapError?: string;
};

export type SourceMapRequest = {
  /** Frame URL without query string or fragment. */
  scriptUrl: string;
  /** Archive metadata for the script, when recorded. */
  entry?: ScriptSourceMapEntry;
};

export type SourceMapPayload = {
  content: string | Uint8Array;
  /** URL relative `sources` resolve against. */
  mapUrl?: string;
};

/** A place source maps can come from: the archive, local files, a symbol server, ... */
export type SourceMapProvider = {
  readonly name: string;
  load(request: SourceMapRequest): Promise<SourceMapPayload | null>;
};

export type SymbolicationStatus = "mapped" | "no-map" | "no-mapping" | "map-error";

export type SymbolicatedFrame = {
  frame: StackFrame;
  status: SymbolicationStatus;
  original?: OriginalPosition & {
    /** Original name of the frame's function (from the caller's call site), when known. */
    functionName?: string;
  };
  snippet?: SourceSnippet;
  /** Provider that supplied the map. */
  mapSource?: string;
  error?: string;
};

export type SourceMapSymbolicatorOptions = {
  /** Tried in order; the first map found for a script wins. */
  providers: readonly SourceMapProvider[];
  /** Recorded script → map table (see `collectScriptSourceMaps`). */
  scripts?: ReadonlyMap<string, ScriptSourceMapEntry>;
  maxMapBytes?: number;
  /** Parsed maps kept in memory (default 32). */
  maxCachedMaps?: number;
  /** Source lines shown around each original position (default 2). */
  snippetContextLines?: number;
};

type LoadedMap =
  | { kind: "map"; map: ParsedSourceMap; source: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; credentials?: "omit" | "same-origin" | "include" }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const SCRIPT_EVENT_TYPE: WebBlackboxEventType = "sys.script";
const DEFAULT_MAX_CACHED_MAPS = 32;
const DEFAULT_SYMBOL_SERVER_TIMEOUT_MS = 15_000;
const MAX_STACK_ARGS = 16;
const MAX_CALL_FRAMES = 64;

/** Merges the archive's `sys.script` events into a table keyed by script location. */
export function collectScriptSourceMaps(
  events: Iterable<WebBlackboxEvent>
): Map<string, ScriptSourceMapEntry> {
  const table = new Map<string, ScriptSourceMapEntry>();

  for (const event of events) {
    if (event.type !== SCRIPT_EVENT_TYPE) {
      continue;
    }

    const parsed = scriptSourceMapDataSchema.safeParse(event.data);

    if (!parsed.success) {
      continue;
    }

    const data = parsed.data;
    const previous = table.get(data.script);
    const sourceMap = data.sourceMap ?? previous?.sourceMap;
    const mapBlobHash = data.map?.contentHash ?? previous?.mapBlobHash;
    const mapError = mapBlobHash ? undefined : (data.mapError ?? previous?.mapError);

    table.set(data.script, {
      script: data.script,
      ...(sourceMap ? { sourceMap } : {}),
      inlineMap: data.inlineMap === true || previous?.inlineMap === true,
      ...(mapBlobHash ? { mapBlobHash } : {}),
      ...(mapError ? { mapError } : {})
    });
  }

  return table;
}

/**
 * Stack frames carried by an error or console event: an `Error.stack`-style text (page errors,
 * rejections, CDP exception descriptions, logged errors), else CDP structured call frames, else
 * the console `stackTop`, else a page error's filename/line/column. On a console entry a logged
 * error's own stack wins over the entry's `stack`, which is where the console method was called.
 */
export function extractEventStack(event: WebBlackboxEvent): StackFrame[] {
  const data = asRecord(event.data);

  if (!data) {
    return [];
  }

  for (const text of collectStackTexts(data, event.type === "console.entry")) {
    const frames = parseStackTrace(text);

    if (frames.length > 0) {
      return frames;
    }
  }

  const callFrames = readCdpCallFrames(asRecord(asRecord(data.exceptionDetails)?.stackTrace));

  if (callFrames.length > 0) {
    return callFrames;
  }

  const stackTop = asString(data.stackTop);
  const topFrame = stackTop
    ? asString(data.source)?.startsWith("cdp.")
      ? parseCdpStackTop(stackTop)
      : parseStackLine(stackTop)
    : null;

  if (topFrame) {
    return [topFrame];
  }

  const filename = asString(data.filename);
  const line = asPositiveInt(data.lineno);
  const column = asPositiveInt(data.colno);

  return filename && line && column
    ? [{ url: filename, line, column, raw: `${filename}:${line}:${column}` }]
    : [];
}

/** Serves maps embedded in the archive at record time. */
export function createArchiveSourceMapProvider(archive: {
  getBlob(hash: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
}): SourceMapProvider {
  return {
    name: "archive",
    async load(request) {
      const hash = request.entry?.mapBlobHash;

      if (!hash) {
        return null;
      }

      const blob = await archive.getBlob(hash);

      return blob
        ? { content: blob.bytes, mapUrl: request.entry?.sourceMap ?? request.scriptUrl }
        : null;
    }
  };
}

export type SourceMapFile = {
  /** Path relative to the folder the user picked (or just the file name). */
  path: string;
  load(): Promise<string | Uint8Array>;
};

/**
 * Serves user-supplied `.map` files. A script matches files named like its recorded map
 * (`main.4f3a.js.map`) or like the script plus `.map`; among same-named files the one whose
 * path shares the longest suffix with the URL path wins.
 */
export function createSourceMapFileProvider(files: readonly SourceMapFile[]): SourceMapProvider {
  const byName = new Map<string, SourceMapFile[]>();

  for (const file of files) {
    const name = baseName(file.path);

    if (name) {
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
  }

  return {
    name: "files",
    async load(request) {
      for (const candidate of mapCandidateUrls(request)) {
        const matches = byName.get(baseName(candidate)) ?? [];
        const best = pickLongestSuffixMatch(matches, urlPath(candidate));

        if (best) {
          return { content: await best.load(), mapUrl: candidate };
        }
      }

      return null;
    }
  };
}

export type SymbolServerProviderOptions = {
  /** Base URL; maps are fetched from `<baseUrl>/<map file name>`. */
  baseUrl: string;
  fetch?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
};

/**
 * Fetches maps by file name from a user-configured base URL ("symbol server"). Only this base
 * URL is ever contacted: URLs recorded in the archive are untrusted and never fetched.
 */
export function createSymbolServerProvider(
  options: SymbolServerProviderOptions
): SourceMapProvider {
  const base = parseHttpBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_MAP_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYMBOL_SERVER_TIMEOUT_MS;

  if (!fetchImpl) {
    throw new Error("Symbol server lookups need a fetch implementation.");
  }

  return {
    name: "symbol-server",
    async load(request) {
      const names = [...new Set(mapCandidateUrls(request).map(baseName).filter(Boolean))];

      for (const name of names) {
        const url = new URL(encodeURIComponent(name), base).href;
        const content = await fetchCapped(fetchImpl, url, maxBytes, timeoutMs);

        if (content) {
          return { content, mapUrl: url };
        }
      }

      return null;
    }
  };
}

/** Maps stack frames back to original sources, caching parsed maps per script. */
export class SourceMapSymbolicator {
  private readonly cache = new Map<string, Promise<LoadedMap>>();

  private readonly providers: readonly SourceMapProvider[];

  private readonly scripts: ReadonlyMap<string, ScriptSourceMapEntry>;

  private readonly maxMapBytes: number;

  private readonly maxCachedMaps: number;

  private readonly snippetContextLines: number | undefined;

  public constructor(options: SourceMapSymbolicatorOptions) {
    this.providers = [...options.providers];
    this.scripts = options.scripts ?? new Map();
    this.maxMapBytes = options.maxMapBytes ?? DEFAULT_SOURCE_MAP_MAX_BYTES;
    this.maxCachedMaps = Math.max(1, options.maxCachedMaps ?? DEFAULT_MAX_CACHED_MAPS);
    this.snippetContextLines = options.snippetContextLines;
  }

  public async symbolicateStack(stack: string): Promise<SymbolicatedFrame[]> {
    return this.symbolicateFrames(parseStackTrace(stack));
  }

  public async symbolicateFrames(frames: readonly StackFrame[]): Promise<SymbolicatedFrame[]> {
    const maps = await Promise.all(frames.map((frame) => this.loadMap(stripFrameUrl(frame.url))));
    const positions = frames.map((frame, index) => {
      const loaded = maps[index];
      return loaded?.kind === "map"
        ? lookupOriginalPosition(loaded.map, frame.line, frame.column)
        : null;
    });

    return frames.map((frame, index) =>
      this.toSymbolicatedFrame(frame, maps[index], positions[index] ?? null, positions[index + 1])
    );
  }

  /** Drops parsed maps, e.g. after new map files were added. */
  public clearCache(): void {
    this.cache.clear();
  }

  private toSymbolicatedFrame(
    frame: StackFrame,
    loaded: LoadedMap | undefined,
    position: OriginalPosition | null,
    callerPosition: OriginalPosition | null | undefined
  ): SymbolicatedFrame {
    if (!loaded || loaded.kind === "none") {
      return { frame, status: "no-map" };
    }

    if (loaded.kind === "error") {
      return { frame, status: "map-error", error: loaded.message };
    }

    if (!position) {
      return { frame, status: "no-mapping", mapSource: loaded.source };
    }

    const snippet = readSourceSnippet(loaded.map, position, this.snippetContextLines);

    return {
      frame,
      status: "mapped",
      original: {
        ...position,
        ...(callerPosition?.name ? { functionName: callerPosition.name } : {})
      },
      ...(snippet ? { snippet } : {}),
      mapSource: loaded.source
    };
  }

  private loadMap(scriptUrl: string): Promise<LoadedMap> {
    const cached = this.cache.get(scriptUrl);

    if (cached) {
      return cached;
    }

    const pending = this.resolveMap(scriptUrl);
    this.cache.set(scriptUrl, pending);

    while (this.cache.size > this.maxCachedMaps) {
      const oldest = this.cache.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      this.cache.delete(oldest);
    }

    return pending;
  }

  private async resolveMap(scriptUrl: string): Promise<LoadedMap> {
    const entry = this.scripts.get(scriptUrl);
    const request: SourceMapRequest = { scriptUrl, ...(entry ? { entry } : {}) };
    let lastError: string | undefined;

    for (const provider of this.providers) {
      try {
        const payload = await provider.load(request);

        if (!payload) {
          continue;
        }

        const map = parseSourceMap(payload.content, {
          maxBytes: this.maxMapBytes,
          ...(payload.mapUrl ? { mapUrl: payload.mapUrl } : {})
        });

        return { kind: "map", map, source: provider.name };
      } catch (error) {
        lastError = `${provider.name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (lastError) {
      return { kind: "error", message: lastError };
    }

    return entry?.mapError
      ? { kind: "error", message: `recorder: ${entry.mapError}` }
      : { kind: "none" };
  }
}

/**
 * Symbolicator for an opened archive: embedded maps first, then `extraProviders` (dropped files,
 * a symbol server, a maps directory).
 */
export function createArchiveSymbolicator(
  archive: {
    query(query: { types: WebBlackboxEventType[] }): WebBlackboxEvent[];
    getBlob(hash: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
  },
  extraProviders: readonly SourceMapProvider[] = [],
  options: Omit<SourceMapSymbolicatorOptions, "providers" | "scripts"> = {}
): SourceMapSymbolicator {
  return new SourceMapSymbolicator({
    ...options,
    providers: [createArchiveSourceMapProvider(archive), ...extraProviders],
    scripts: collectScriptSourceMaps(archive.query({ types: [SCRIPT_EVENT_TYPE] }))
  });
}

function collectStackTexts(data: Record<string, unknown>, isConsoleEntry: boolean): string[] {
  const exception = asRecord(asRecord(data.exceptionDetails)?.exception);
  const args = Array.isArray(data.args) ? data.args.slice(0, MAX_STACK_ARGS) : [];
  const argStacks = args.map((arg) => (typeof arg === "string" ? arg : asRecord(arg)?.stack));
  const candidates = isConsoleEntry
    ? [...argStacks, data.stack]
    : [
        data.stack,
        asRecord(data.reason)?.stack,
        asRecord(data.error)?.stack,
        exception?.description,
        ...argStacks
      ];

  return candidates.filter((value): value is string => typeof value === "string" && !!value);
}

function readCdpCallFrames(stackTrace: Record<string, unknown> | null): StackFrame[] {
  const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];

  return callFrames.slice(0, MAX_CALL_FRAMES).flatMap((entry) => {
    const frame = asRecord(entry);
    const url = asString(frame?.url);
    const line = asNonNegativeInt(frame?.lineNumber);
    const column = asNonNegativeInt(frame?.columnNumber);

    if (!url || line === null || column === null) {
      return [];
    }

    const functionName = asString(frame?.functionName);

    return [
      {
        ...(functionName ? { functionName } : {}),
        url,
        line: line + 1,
        column: column + 1,
        raw: `${functionName || "(anonymous)"} @ ${url}:${line + 1}:${column + 1}`
      }
    ];
  });
}

function mapCandidateUrls(request: SourceMapRequest): string[] {
  const candidates = [request.entry?.sourceMap, `${request.scriptUrl}.map`];
  return [...new Set(candidates.filter((value): value is string => !!value))];
}

function pickLongestSuffixMatch(
  files: readonly SourceMapFile[],
  targetPath: string
): SourceMapFile | undefined {
  const target = splitPath(targetPath);
  let best: SourceMapFile | undefined;
  let bestScore = -1;

  for (const file of files) {
    const score = commonSuffixLength(splitPath(file.path), target);

    if (score > bestScore) {
      best = file;
      bestScore = score;
    }
  }

  return best;
}

function commonSuffixLength(left: string[], right: string[]): number {
  let count = 0;

  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }

  return count;
}

function splitPath(path: string): string[] {
  return path.split(/[\\/]/u).filter(Boolean);
}

function baseName(pathOrUrl: string): string {
  return splitPath(urlPath(pathOrUrl)).at(-1) ?? "";
}

function urlPath(value: string): string {
  try {
    return safeDecodeURIComponent(new URL(value).pathname);
  } catch {
    return stripFrameUrl(value);
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHttpBaseUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid symbol server URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Symbol server URL must use http or https.");
  }

  url.search = "";
  url.hash = "";

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

async function fetchCapped(
  fetchImpl: FetchLike,
  url: string,
  maxBytes: number,
  timeoutMs: number
): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      credentials: "same-origin"
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new SourceMapError(`Source map is ${declared} bytes; the limit is ${maxBytes}.`);
    }

    return await readBodyCapped(response, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(
  response: Awaited<ReturnType<FetchLike>>,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = response.body?.getReader();

  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength > maxBytes) {
      throw new SourceMapError(`Source map exceeds ${maxBytes} bytes.`);
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
      await reader.cancel().catch(() => undefined);
      throw new SourceMapError(`Source map exceeds ${maxBytes} bytes.`);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
