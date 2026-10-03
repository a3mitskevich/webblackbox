import {
  createArchiveSymbolicator,
  createSourceMapFileProvider,
  createSymbolServerProvider,
  extractEventStack,
  type SourceMapFile,
  type SourceMapProvider,
  type SourceMapSymbolicator,
  type SymbolicatedFrame
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent, WebBlackboxEventType } from "@webblackbox/protocol";

import { escapeHtml } from "./dom.js";
import { readStoredText, writeStoredText } from "./storage.js";

export type StackViewMessages = {
  heading: string;
  showOriginal: string;
  showRaw: string;
  loadMapFiles: string;
  loadMapFolder: string;
  symbolServerPlaceholder: string;
  symbolServerApply: string;
  /** `{count}` is replaced with the number of loaded files. */
  mapsLoaded: string;
  resolving: string;
  noMap: string;
  noMapping: string;
  mapError: string;
  invalidSymbolServer: string;
};

export type StackViewMode = "original" | "raw";

type SymbolicationArchive = {
  query(query: { types: WebBlackboxEventType[] }): WebBlackboxEvent[];
  getBlob(hash: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
};

export type StackViewController = {
  /** New archive (or none): drops cached results. */
  setArchive(archive: SymbolicationArchive | null): void;
  /** Shows the stack of the selected event (hidden when it has none). */
  render(event: WebBlackboxEvent | null): void;
  /** Starts symbolicating an event in the background (console rows). */
  prefetch(event: WebBlackboxEvent): void;
  /** `src/file.ts:12:5` of the event's first mapped frame, once resolved. */
  describeTopFrame(event: WebBlackboxEvent): string | null;
};

export const SYMBOL_SERVER_STORAGE_KEY = "webblackbox.player.symbolServer";
const MAX_MAP_FILES = 2_000;
const MAX_CACHED_EVENTS = 500;

/** Original location of a mapped frame, e.g. `src/cart.ts:7:13`; `null` otherwise. */
export function describeOriginalFrame(frame: SymbolicatedFrame | undefined): string | null {
  const original = frame?.status === "mapped" ? frame.original : undefined;
  return original ? `${shortSource(original.source)}:${original.line}:${original.column}` : null;
}

/** Frame list markup; every archive- or map-derived string is escaped. */
export function renderStackFramesHtml(
  frames: readonly SymbolicatedFrame[],
  mode: StackViewMode,
  messages: StackViewMessages
): string {
  const items = frames.map((entry) => {
    const raw = `<code class="stack-frame-raw">${escapeHtml(entry.frame.raw)}</code>`;

    if (mode === "raw") {
      return `<li class="stack-frame">${raw}</li>`;
    }

    if (entry.status !== "mapped" || !entry.original) {
      const reason =
        entry.status === "map-error"
          ? `${messages.mapError}: ${entry.error ?? ""}`
          : entry.status === "no-mapping"
            ? messages.noMapping
            : messages.noMap;

      return `<li class="stack-frame stack-frame-unmapped">${raw}<span class="stack-frame-note">${escapeHtml(reason)}</span></li>`;
    }

    const name = entry.original.functionName ?? entry.frame.functionName ?? "(anonymous)";
    const location = `${entry.original.source}:${entry.original.line}:${entry.original.column}`;
    const snippet = entry.snippet ? renderSnippet(entry.snippet) : "";

    return `<li class="stack-frame stack-frame-mapped"><span class="stack-frame-name">${escapeHtml(name)}</span> <span class="stack-frame-location" title="${escapeHtml(entry.frame.raw)}">${escapeHtml(location)}</span><span class="stack-frame-source">${escapeHtml(entry.mapSource ?? "")}</span>${snippet}</li>`;
  });

  return `<ol class="stack-frames">${items.join("")}</ol>`;
}

/**
 * Stack trace block of the event details card: maps frames through maps embedded in the
 * archive, `.map` files or a folder the user loads, and an optional symbol server URL
 * (remembered in localStorage). Results are cached per event until the sources change.
 */
export function createStackViewController(options: {
  root: HTMLElement;
  messages: StackViewMessages;
  /** Called when a background result arrives (to refresh console rows). */
  onResolved?: () => void;
}): StackViewController {
  const { root, messages } = options;
  let archive: SymbolicationArchive | null = null;
  let mapFiles: SourceMapFile[] = [];
  let symbolServer = readStoredText(SYMBOL_SERVER_STORAGE_KEY) ?? "";
  let symbolicator: SourceMapSymbolicator | null = null;
  let mode: StackViewMode = "original";
  let currentEvent: WebBlackboxEvent | null = null;
  let status = "";
  const results = new Map<string, SymbolicatedFrame[]>();
  const pending = new Map<string, Promise<SymbolicatedFrame[]>>();

  root.innerHTML = `
    <div class="stack-toolbar">
      <h3 class="stack-heading">${escapeHtml(messages.heading)}</h3>
      <button type="button" class="stack-mode" data-stack-action="mode"></button>
      <label class="stack-load">${escapeHtml(messages.loadMapFiles)}<input type="file" multiple accept=".map,.json,application/json" data-stack-input="files" /></label>
      <label class="stack-load">${escapeHtml(messages.loadMapFolder)}<input type="file" multiple webkitdirectory data-stack-input="folder" /></label>
      <input type="url" class="stack-symbol-server" placeholder="${escapeHtml(messages.symbolServerPlaceholder)}" data-stack-input="server" />
      <button type="button" data-stack-action="server">${escapeHtml(messages.symbolServerApply)}</button>
    </div>
    <p class="stack-status" data-stack-status></p>
    <div data-stack-frames></div>`;

  const modeButton = root.querySelector<HTMLButtonElement>('[data-stack-action="mode"]');
  const serverInput = root.querySelector<HTMLInputElement>('[data-stack-input="server"]');
  const statusNode = root.querySelector<HTMLElement>("[data-stack-status]");
  const framesNode = root.querySelector<HTMLElement>("[data-stack-frames]");

  if (serverInput) {
    serverInput.value = symbolServer;
  }

  const clearResults = (): void => {
    results.clear();
    pending.clear();
  };

  const resetSymbolicator = (): void => {
    symbolicator = null;
    clearResults();
  };

  const getSymbolicator = (): SourceMapSymbolicator | null => {
    if (!archive) {
      return null;
    }

    if (!symbolicator) {
      const providers: SourceMapProvider[] = [];

      if (mapFiles.length > 0) {
        providers.push(createSourceMapFileProvider(mapFiles));
      }

      if (symbolServer) {
        try {
          providers.push(createSymbolServerProvider({ baseUrl: symbolServer }));
        } catch {
          status = messages.invalidSymbolServer;
        }
      }

      symbolicator = createArchiveSymbolicator(archive, providers);
    }

    return symbolicator;
  };

  const resolve = (event: WebBlackboxEvent): Promise<SymbolicatedFrame[]> | null => {
    const existing = pending.get(event.id);

    if (existing) {
      return existing;
    }

    const frames = extractEventStack(event);
    const active = frames.length > 0 ? getSymbolicator() : null;

    if (!active) {
      return null;
    }

    if (pending.size >= MAX_CACHED_EVENTS) {
      clearResults();
    }

    const task = active.symbolicateFrames(frames).then((resolved) => {
      results.set(event.id, resolved);
      return resolved;
    });

    pending.set(event.id, task);
    return task;
  };

  const draw = (): void => {
    const event = currentEvent;
    const frames = event ? extractEventStack(event) : [];

    root.hidden = !event || frames.length === 0;

    if (!event || frames.length === 0) {
      return;
    }

    if (modeButton) {
      modeButton.textContent = mode === "original" ? messages.showRaw : messages.showOriginal;
    }

    const resolved = results.get(event.id);

    if (statusNode) {
      statusNode.textContent = status || (resolved || mode === "raw" ? "" : messages.resolving);
    }

    if (framesNode) {
      framesNode.innerHTML = renderStackFramesHtml(
        resolved ?? frames.map((frame) => ({ frame, status: "no-map" as const })),
        resolved ? mode : "raw",
        messages
      );
    }
  };

  const refresh = (): void => {
    const event = currentEvent;
    const task = event ? resolve(event) : null;

    draw();

    void task
      ?.then(() => {
        if (event && currentEvent?.id === event.id) {
          draw();
        }
      })
      .catch((error: unknown) => {
        status = `${messages.mapError}: ${error instanceof Error ? error.message : String(error)}`;
        draw();
      });
  };

  const loadFiles = (input: HTMLInputElement): void => {
    const files = Array.from(input.files ?? [])
      .filter((file) => /\.(map|json)$/iu.test(file.name))
      .slice(0, MAX_MAP_FILES);

    mapFiles = [
      ...mapFiles,
      ...files.map((file) => ({
        path: file.webkitRelativePath || file.name,
        load: async () => new Uint8Array(await file.arrayBuffer())
      }))
    ].slice(-MAX_MAP_FILES);
    status = messages.mapsLoaded.replace("{count}", String(mapFiles.length));
    input.value = "";
    resetSymbolicator();
    refresh();
    options.onResolved?.();
  };

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLElement>("[data-stack-action]")?.dataset.stackAction;

    if (action === "mode") {
      mode = mode === "original" ? "raw" : "original";
      draw();
      return;
    }

    if (action === "server") {
      symbolServer = serverInput?.value.trim() ?? "";
      writeStoredText(SYMBOL_SERVER_STORAGE_KEY, symbolServer);
      status = "";
      resetSymbolicator();
      refresh();
      options.onResolved?.();
    }
  });

  root.addEventListener("change", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;

    if (input?.dataset.stackInput === "files" || input?.dataset.stackInput === "folder") {
      loadFiles(input);
    }
  });

  root.hidden = true;

  return {
    setArchive(next) {
      archive = next;
      currentEvent = null;
      status = "";
      resetSymbolicator();
      draw();
    },
    render(event) {
      currentEvent = event;
      refresh();
    },
    prefetch(event) {
      if (results.has(event.id) || pending.has(event.id)) {
        return;
      }

      void resolve(event)
        ?.then(() => options.onResolved?.())
        .catch(() => undefined);
    },
    describeTopFrame(event) {
      return describeOriginalFrame(
        results.get(event.id)?.find((frame) => frame.status === "mapped")
      );
    }
  };
}

function renderSnippet(snippet: NonNullable<SymbolicatedFrame["snippet"]>): string {
  const lines = snippet.lines.map((line, index) => {
    const lineNumber = snippet.startLine + index;
    const className =
      lineNumber === snippet.highlightLine ? "stack-snippet-line is-hit" : "stack-snippet-line";

    return `<span class="${className}"><span class="stack-snippet-number">${lineNumber}</span>${escapeHtml(line)}</span>`;
  });

  return `<pre class="stack-snippet">${lines.join("\n")}</pre>`;
}

function shortSource(source: string): string {
  const withoutOrigin = source.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/iu, "");
  const parts = withoutOrigin.split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.slice(-3).join("/") || source;
}
