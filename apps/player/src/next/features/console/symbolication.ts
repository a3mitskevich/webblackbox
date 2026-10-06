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

import { readStoredText, writeStoredText } from "../../../lib/storage.js";

/** What symbolication needs from an archive (a `WebBlackboxPlayer` fits). */
export type SymbolicationArchive = {
  query(query: { types: WebBlackboxEventType[] }): WebBlackboxEvent[];
  getBlob(hash: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
};

export type StackResolution =
  | { status: "pending" }
  | { status: "done"; frames: readonly SymbolicatedFrame[] }
  | { status: "error"; message: string };

export type SymbolicationSources = {
  mapFileCount: number;
  symbolServer: string;
  /** The symbol server URL could not be used (not http/https, …). */
  symbolServerInvalid: boolean;
};

/**
 * Stack symbolication for one archive, outside React: maps embedded in the archive, `.map` files
 * or a folder the user picks, and an optional symbol server (remembered in localStorage).
 * Results are cached per event until the sources change; subscribers hear about every change.
 */
export type SymbolicationService = {
  /** Starts resolving the event's stack (no-op when cached, running or without a stack). */
  request(event: WebBlackboxEvent): void;
  peek(eventId: string): StackResolution | undefined;
  /** The same object until the sources change (a `useSyncExternalStore` snapshot). */
  sources(): SymbolicationSources;
  addMapFiles(files: readonly SourceMapFile[]): void;
  setSymbolServer(url: string): void;
  subscribe(listener: () => void): () => void;
  /** Bumped on every change (the `useSyncExternalStore` snapshot). */
  version(): number;
};

export type SymbolicationStorage = {
  readServer(): string;
  writeServer(url: string): void;
};

/** The classic player's key (`lib/stack-view.ts`), so both UIs share the saved server. */
const SYMBOL_SERVER_STORAGE_KEY = "webblackbox.player.symbolServer";
const MAX_MAP_FILES = 2_000;
const MAX_CACHED_EVENTS = 500;

const browserStorage: SymbolicationStorage = {
  readServer: () => readStoredText(SYMBOL_SERVER_STORAGE_KEY) ?? "",
  writeServer: (url) => writeStoredText(SYMBOL_SERVER_STORAGE_KEY, url)
};

export function createSymbolicationService(
  archive: SymbolicationArchive,
  storage: SymbolicationStorage = browserStorage
): SymbolicationService {
  const listeners = new Set<() => void>();
  let results = new Map<string, StackResolution>();
  let mapFiles: readonly SourceMapFile[] = [];
  let symbolServer = storage.readServer();
  let symbolServerInvalid = !isUsableSymbolServer(symbolServer);
  let symbolicator: SourceMapSymbolicator | null = null;
  let sources: SymbolicationSources = { mapFileCount: 0, symbolServer, symbolServerInvalid };
  let generation = 0;
  let version = 0;

  const notify = (): void => {
    version += 1;

    if (
      sources.mapFileCount !== mapFiles.length ||
      sources.symbolServer !== symbolServer ||
      sources.symbolServerInvalid !== symbolServerInvalid
    ) {
      sources = { mapFileCount: mapFiles.length, symbolServer, symbolServerInvalid };
    }

    for (const listener of [...listeners]) {
      listener();
    }
  };

  const reset = (): void => {
    symbolicator = null;
    results = new Map();
    generation += 1;
    notify();
  };

  const getSymbolicator = (): SourceMapSymbolicator => {
    if (symbolicator) {
      return symbolicator;
    }

    const providers: SourceMapProvider[] = [];

    if (mapFiles.length > 0) {
      providers.push(createSourceMapFileProvider(mapFiles));
    }

    if (symbolServer && !symbolServerInvalid) {
      providers.push(createSymbolServerProvider({ baseUrl: symbolServer }));
    }

    symbolicator = createArchiveSymbolicator(archive, providers);
    return symbolicator;
  };

  const settle = (eventId: string, token: number, resolution: StackResolution): void => {
    if (token !== generation) {
      return;
    }

    results = new Map(results).set(eventId, resolution);
    notify();
  };

  return {
    request(event) {
      if (results.has(event.id)) {
        return;
      }

      const frames = extractEventStack(event);

      if (frames.length === 0) {
        return;
      }

      if (results.size >= MAX_CACHED_EVENTS) {
        results = new Map();
      }

      const token = generation;
      results = new Map(results).set(event.id, { status: "pending" });
      notify();
      getSymbolicator()
        .symbolicateFrames(frames)
        .then(
          (resolved) => settle(event.id, token, { status: "done", frames: resolved }),
          (error: unknown) =>
            settle(event.id, token, {
              status: "error",
              message: error instanceof Error ? error.message : String(error)
            })
        );
    },
    peek: (eventId) => results.get(eventId),
    sources: () => sources,
    addMapFiles(files) {
      if (files.length === 0) {
        return;
      }

      mapFiles = [...mapFiles, ...files].slice(-MAX_MAP_FILES);
      reset();
    },
    setSymbolServer(url) {
      const next = url.trim();

      if (next === symbolServer) {
        return;
      }

      symbolServer = next;
      symbolServerInvalid = !isUsableSymbolServer(next);
      storage.writeServer(next);
      reset();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version
  };
}

/** Whether the symbol server URL can be used (empty means "no server", which is fine). */
function isUsableSymbolServer(url: string): boolean {
  if (!url) {
    return true;
  }

  try {
    createSymbolServerProvider({ baseUrl: url });
    return true;
  } catch {
    return false;
  }
}

/** `.map` / `.json` files the user picked (a file list or a folder), as symbolicator inputs. */
export function toSourceMapFiles(files: readonly File[]): SourceMapFile[] {
  return files
    .filter((file) => /\.(map|json)$/iu.test(file.name))
    .slice(0, MAX_MAP_FILES)
    .map((file) => ({
      path: file.webkitRelativePath || file.name,
      load: async () => new Uint8Array(await file.arrayBuffer())
    }));
}

const services = new WeakMap<SymbolicationArchive, SymbolicationService>();

/** One service per opened archive (dropped with the archive). */
export function getSymbolicationService(archive: SymbolicationArchive): SymbolicationService {
  const existing = services.get(archive);

  if (existing) {
    return existing;
  }

  const service = createSymbolicationService(archive);
  services.set(archive, service);
  return service;
}
