import { extractSourceMappingUrl } from "@webblackbox/protocol";

/** Raw capture event type of a script → source map reference. */
export const SCRIPT_SOURCE_MAP_RAW_TYPE = "script";

const DEFAULT_MAX_SCRIPTS = 100;
const DEFAULT_MAX_SCRIPT_BYTES = 5 * 1024 * 1024;
const SCAN_DELAY_MS = 50;
const SOURCE_MAP_HEADERS = ["SourceMap", "X-SourceMap"] as const;

export type ScriptSourceMapReference = {
  url: string;
  sourceMapUrl: string;
  origin: "header" | "comment";
};

type ScannerFetch = (
  input: string,
  init: { cache: "force-cache"; credentials: "same-origin" }
) => Promise<{
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type ScriptSourceMapScannerOptions = {
  emit: (reference: ScriptSourceMapReference) => void;
  /** Defaults to the page's `fetch`; injected for tests. */
  fetch?: ScannerFetch;
  document?: Pick<Document, "scripts">;
  performance?: Pick<Performance, "getEntriesByType">;
  /** Only scripts from this origin are read (cross-origin reads would fail CORS noisily). */
  origin?: string;
  maxScripts?: number;
  maxScriptBytes?: number;
};

/**
 * Finds same-origin scripts (`<script src>` and resource timing entries, including scripts
 * loaded later) and reports the source map each one references, via its `SourceMap` header or
 * trailing `//# sourceMappingURL=` comment. Scripts are re-read with `cache: "force-cache"`,
 * one at a time, so this normally hits the HTTP cache. Returns a stop function.
 */
export function startScriptSourceMapScanner(options: ScriptSourceMapScannerOptions): () => void {
  const fetchImpl = options.fetch ?? (globalThis.fetch?.bind(globalThis) as ScannerFetch);
  const origin = options.origin ?? globalThis.location?.origin;
  const maxScripts = options.maxScripts ?? DEFAULT_MAX_SCRIPTS;
  const maxScriptBytes = options.maxScriptBytes ?? DEFAULT_MAX_SCRIPT_BYTES;
  const seen = new Set<string>();
  const queue: string[] = [];
  let stopped = false;
  let draining = false;
  let observer: PerformanceObserver | null = null;

  if (!fetchImpl || !origin) {
    return () => undefined;
  }

  const drain = async (): Promise<void> => {
    if (draining) {
      return;
    }

    draining = true;

    try {
      while (!stopped && queue.length > 0) {
        const url = queue.shift() as string;
        await delay(SCAN_DELAY_MS);

        const reference = stopped ? null : await readReference(fetchImpl, url, maxScriptBytes);

        if (reference && !stopped) {
          options.emit(reference);
        }
      }
    } finally {
      draining = false;
    }
  };

  const enqueue = (rawUrl: string): void => {
    const url = toSameOriginScriptUrl(rawUrl, origin);

    if (!url || seen.has(url) || seen.size >= maxScripts) {
      return;
    }

    seen.add(url);
    queue.push(url);
    void drain();
  };

  const scripts = options.document?.scripts ?? globalThis.document?.scripts;

  for (const script of Array.from(scripts ?? [])) {
    if (script.src) {
      enqueue(script.src);
    }
  }

  const performanceApi = options.performance ?? globalThis.performance;

  for (const entry of performanceApi?.getEntriesByType?.("resource") ?? []) {
    if ((entry as PerformanceResourceTiming).initiatorType === "script") {
      enqueue(entry.name);
    }
  }

  if (!options.performance && typeof PerformanceObserver === "function") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if ((entry as PerformanceResourceTiming).initiatorType === "script") {
            enqueue(entry.name);
          }
        }
      });
      observer.observe({ type: "resource" });
    } catch {
      observer = null;
    }
  }

  return () => {
    stopped = true;
    queue.length = 0;
    observer?.disconnect();
  };
}

async function readReference(
  fetchImpl: ScannerFetch,
  url: string,
  maxScriptBytes: number
): Promise<ScriptSourceMapReference | null> {
  try {
    const response = await fetchImpl(url, { cache: "force-cache", credentials: "same-origin" });

    if (!response.ok) {
      return null;
    }

    for (const name of SOURCE_MAP_HEADERS) {
      const header = response.headers.get(name)?.trim();

      if (header) {
        return { url, sourceMapUrl: header, origin: "header" };
      }
    }

    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxScriptBytes) {
      return null;
    }

    const text = await response.text();
    const sourceMapUrl = text.length <= maxScriptBytes ? extractSourceMappingUrl(text) : undefined;

    return sourceMapUrl ? { url, sourceMapUrl, origin: "comment" } : null;
  } catch {
    return null;
  }
}

function toSameOriginScriptUrl(value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin);

    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
      return null;
    }

    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
