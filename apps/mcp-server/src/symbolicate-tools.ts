import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  createArchiveSymbolicator,
  createSourceMapFileProvider,
  DEFAULT_SOURCE_MAP_MAX_BYTES,
  extractEventStack,
  parseStackTrace,
  type SourceMapFile,
  type SourceMapProvider,
  type SymbolicatedFrame
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { z } from "zod";

import { openArchivePlayer, resolveArchivePath } from "./session-tools.js";

const DEFAULT_EVENT_LIMIT = 10;
const MAX_EVENT_LIMIT = 50;
const MAX_STACK_CHARS = 64 * 1024;
const MAX_MAP_FILES = 5_000;
const MAX_MAP_DIR_DEPTH = 8;
const MAX_MESSAGE_CHARS = 300;

export const symbolicateStackInput = {
  path: z.string().min(1).describe("Path to a .webblackbox or .zip archive."),
  passphrase: z.string().min(1).max(4096).optional().describe("Passphrase for encrypted archives."),
  eventId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Symbolicate the stack of this event only."),
  stack: z
    .string()
    .min(1)
    .max(MAX_STACK_CHARS)
    .optional()
    .describe("A raw stack trace to symbolicate with the archive's maps (and mapsDir)."),
  mapsDir: z
    .string()
    .min(1)
    .optional()
    .describe("Directory with .map files (searched recursively, matched by file name)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_EVENT_LIMIT)
    .optional()
    .describe(
      `Error events to symbolicate when neither eventId nor stack is given (1-${MAX_EVENT_LIMIT}).`
    )
};

/**
 * `index.ts` passes `path` and `mapsDir` through a single call site so a directory guard
 * (`--allow-dir`) can be applied to both before they reach the filesystem.
 */
export type SymbolicateStackArgs = {
  path: string;
  passphrase?: string;
  eventId?: string;
  stack?: string;
  mapsDir?: string;
  limit?: number;
};

export type SymbolicatedStackFrame = {
  raw: string;
  status: SymbolicatedFrame["status"];
  original?: { source: string; line: number; column: number; functionName?: string };
  snippet?: { startLine: number; highlightLine: number; lines: string[] };
  mapSource?: string;
  error?: string;
};

export type SymbolicatedStack = {
  eventId?: string;
  type?: string;
  message?: string;
  frames: SymbolicatedStackFrame[];
};

/**
 * Maps stack traces from an archive (one event, the error events, or a pasted stack) back to
 * original sources, using maps embedded at record time plus `.map` files under `mapsDir`.
 */
export async function symbolicateArchiveStacks(args: SymbolicateStackArgs): Promise<{
  path: string;
  mapsDir?: string;
  mapFiles: number;
  stacks: SymbolicatedStack[];
}> {
  const archivePath = resolveArchivePath(args.path);
  const mapsDir = args.mapsDir ? resolveArchivePath(args.mapsDir) : undefined;
  const player = await openArchivePlayer(archivePath, args.passphrase);
  const mapFiles = mapsDir ? await collectMapFiles(mapsDir) : [];
  const providers: SourceMapProvider[] =
    mapFiles.length > 0 ? [createSourceMapFileProvider(mapFiles)] : [];
  const symbolicator = createArchiveSymbolicator(player, providers);
  const stacks: SymbolicatedStack[] = [];

  if (args.stack) {
    const frames = await symbolicator.symbolicateFrames(parseStackTrace(args.stack));
    stacks.push({ frames: frames.map(toFrame) });
  } else {
    for (const event of selectEvents(player.events, args)) {
      const frames = await symbolicator.symbolicateFrames(extractEventStack(event));
      stacks.push({
        eventId: event.id,
        type: event.type,
        ...readMessage(event),
        frames: frames.map(toFrame)
      });
    }
  }

  return {
    path: archivePath,
    ...(mapsDir ? { mapsDir } : {}),
    mapFiles: mapFiles.length,
    stacks
  };
}

function selectEvents(
  events: readonly WebBlackboxEvent[],
  args: SymbolicateStackArgs
): WebBlackboxEvent[] {
  if (args.eventId) {
    const event = events.find((entry) => entry.id === args.eventId);

    if (!event) {
      throw new Error(`Event '${args.eventId}' not found in the archive.`);
    }

    return [event];
  }

  return events
    .filter((event) => isErrorLike(event) && extractEventStack(event).length > 0)
    .slice(0, args.limit ?? DEFAULT_EVENT_LIMIT);
}

function isErrorLike(event: WebBlackboxEvent): boolean {
  return (
    event.type.startsWith("error.") ||
    event.lvl === "error" ||
    (event.type === "console.entry" && readData(event).level === "error")
  );
}

/** `.map` files under `root`; symbolic links are skipped so nothing outside it is read. */
async function collectMapFiles(root: string): Promise<SourceMapFile[]> {
  const files: SourceMapFile[] = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (pending.length > 0 && files.length < MAX_MAP_FILES) {
    const { dir, depth } = pending.shift() as { dir: string; depth: number };

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory() && depth < MAX_MAP_DIR_DEPTH) {
        pending.push({ dir: fullPath, depth: depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".map") && files.length < MAX_MAP_FILES) {
        files.push({ path: relative(root, fullPath), load: () => readMapFile(fullPath) });
      }
    }
  }

  return files;
}

async function readMapFile(path: string): Promise<Uint8Array> {
  const info = await lstat(path);

  if (!info.isFile()) {
    throw new Error(`${path} is not a regular file.`);
  }

  if (info.size > DEFAULT_SOURCE_MAP_MAX_BYTES) {
    throw new Error(`${path} is larger than ${DEFAULT_SOURCE_MAP_MAX_BYTES} bytes.`);
  }

  return new Uint8Array(await readFile(path));
}

function toFrame(entry: SymbolicatedFrame): SymbolicatedStackFrame {
  const functionName = entry.original?.functionName ?? entry.frame.functionName;

  return {
    raw: entry.frame.raw,
    status: entry.status,
    ...(entry.original
      ? {
          original: {
            source: entry.original.source,
            line: entry.original.line,
            column: entry.original.column,
            ...(functionName ? { functionName } : {})
          }
        }
      : {}),
    ...(entry.snippet ? { snippet: entry.snippet } : {}),
    ...(entry.mapSource ? { mapSource: entry.mapSource } : {}),
    ...(entry.error ? { error: entry.error } : {})
  };
}

function readMessage(event: WebBlackboxEvent): { message?: string } {
  const data = readData(event);
  const message = [data.message, data.text].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  return message ? { message: message.slice(0, MAX_MESSAGE_CHARS) } : {};
}

function readData(event: WebBlackboxEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : {};
}
