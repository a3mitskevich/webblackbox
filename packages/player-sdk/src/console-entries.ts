import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { readConsoleLevel } from "./problems.js";
import { extractEventStack } from "./symbolicate.js";
import { isThirdPartyUrl } from "./third-party.js";

/** Console levels the Player filters by (`assert` and exceptions count as errors). */
export type ConsoleLevel = "error" | "warn" | "info" | "log" | "debug";

export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["error", "warn", "info", "log", "debug"];

/** Where a console row comes from. */
export type ConsoleEntryKind =
  | "console"
  | "exception"
  | "rejection"
  | "resource"
  | "assert"
  | "other";

/** Script position a console row points at (the top stack frame, else the logged URL). */
export type ConsoleLocation = {
  url: string;
  line?: number;
  column?: number;
};

/** One console row of the Player: a `console.entry`, an `error.*` event or another error event. */
export type ConsoleEntry = {
  eventId: string;
  mono: number;
  level: ConsoleLevel;
  kind: ConsoleEntryKind;
  /** The message as the page printed it (text, else joined arguments, else the error message). */
  message: string;
  /** Recorder source, e.g. `cdp.runtime`, `cdp.log`, `console-api`. */
  source?: string;
  location: ConsoleLocation | null;
  /** The network request this row is about (`Failed to load resource`, …). */
  reqId?: string;
  /** Whether the stack or the logged URL belongs to another site than the recording. */
  isThirdParty: boolean;
  /** Rows with the same key are "similar" (same level, message and location). */
  groupKey: string;
  /** The event carries stack frames the symbolicator can map. */
  hasStack: boolean;
};

/** Similar console rows folded into the first one (Group similar). */
export type ConsoleEntryGroup = {
  entry: ConsoleEntry;
  /** Every row of the group in time order, the first one included. */
  memberIds: string[];
  count: number;
  /** The newest member's time (the first one's is `entry.mono`). */
  lastMono: number;
};

export type ConsoleEntryOptions = {
  /** The recorded site (`manifest.site.origin`); without it nothing is third-party. */
  siteOrigin?: string;
};

const MAX_MESSAGE_CHARS = 4_000;
const MAX_ARGUMENTS = 16;

/** Console rows of the events (in their order); events that are not console rows are skipped. */
export function buildConsoleEntries(
  events: readonly WebBlackboxEvent[],
  options: ConsoleEntryOptions = {}
): ConsoleEntry[] {
  return events.flatMap((event) => {
    const entry = toConsoleEntry(event, options);
    return entry ? [entry] : [];
  });
}

/** One console row, or `null` for events that are not console output or errors. */
export function toConsoleEntry(
  event: WebBlackboxEvent,
  options: ConsoleEntryOptions = {}
): ConsoleEntry | null {
  const kind = readKind(event);

  if (!kind) {
    return null;
  }

  const data = asRecord(event.data);
  const level = readLevel(event, kind);
  const message = readMessage(data, event.type);
  const frames = extractEventStack(event);
  const top = frames[0];
  const loggedUrl = asString(data?.url) ?? asString(data?.filename);
  const location: ConsoleLocation | null = top
    ? { url: top.url, line: top.line, column: top.column }
    : loggedUrl
      ? {
          url: loggedUrl,
          ...readPosition(data?.line ?? data?.lineno, "line"),
          ...readPosition(data?.col ?? data?.colno, "column")
        }
      : null;
  const reqId = asString(data?.networkRequestId) ?? asString(data?.requestId);
  const source = asString(data?.source);
  const thirdPartyUrl = loggedUrl ?? top?.url;

  return {
    eventId: event.id,
    mono: event.mono,
    level,
    kind,
    message,
    ...(source ? { source } : {}),
    location,
    ...(reqId ? { reqId } : {}),
    isThirdParty: Boolean(
      options.siteOrigin && thirdPartyUrl && isThirdPartyUrl(thirdPartyUrl, options.siteOrigin)
    ),
    groupKey: `${level}\u0000${message}\u0000${location ? stripQuery(location.url) : ""}`,
    hasStack: frames.length > 0
  };
}

/**
 * Folds similar rows (same `groupKey`) into their first occurrence; groups keep the time order of
 * their first row.
 */
export function groupConsoleEntries(entries: readonly ConsoleEntry[]): ConsoleEntryGroup[] {
  const groups: ConsoleEntryGroup[] = [];
  const indexByKey = new Map<string, number>();

  for (const entry of entries) {
    const index = indexByKey.get(entry.groupKey);
    const group = index === undefined ? undefined : groups[index];

    if (index === undefined || !group) {
      indexByKey.set(entry.groupKey, groups.length);
      groups.push({ entry, memberIds: [entry.eventId], count: 1, lastMono: entry.mono });
      continue;
    }

    groups[index] = {
      ...group,
      memberIds: [...group.memberIds, entry.eventId],
      count: group.count + 1,
      lastMono: Math.max(group.lastMono, entry.mono)
    };
  }

  return groups;
}

/** Rows per level (the filter chip counts). */
export function countConsoleLevels(entries: readonly ConsoleEntry[]): Record<ConsoleLevel, number> {
  const counts: Record<ConsoleLevel, number> = { error: 0, warn: 0, info: 0, log: 0, debug: 0 };

  for (const entry of entries) {
    counts[entry.level] += 1;
  }

  return counts;
}

function readKind(event: WebBlackboxEvent): ConsoleEntryKind | null {
  switch (event.type) {
    case "console.entry":
      return "console";
    case "error.exception":
      return "exception";
    case "error.unhandledrejection":
      return "rejection";
    case "error.resource":
      return "resource";
    case "error.assert":
      return "assert";
    default:
      return event.lvl === "error" ? "other" : null;
  }
}

function readLevel(event: WebBlackboxEvent, kind: ConsoleEntryKind): ConsoleLevel {
  if (kind !== "console") {
    return "error";
  }

  const raw = readConsoleLevel(event) ?? "log";

  switch (raw) {
    case "error":
    case "assert":
      return "error";
    case "warn":
    case "warning":
      return "warn";
    case "info":
    case "debug":
      return raw;
    case "verbose":
      return "debug";
    default:
      return "log";
  }
}

function readMessage(data: Record<string, unknown> | null, type: string): string {
  const text =
    asString(data?.text) ??
    readArguments(data?.args) ??
    asString(data?.message) ??
    asString(data?.reason) ??
    asString(data?.description);

  if (!text) {
    return type;
  }

  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function readArguments(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  return value
    .slice(0, MAX_ARGUMENTS)
    .map((item) => (typeof item === "string" ? item : safeStringify(item)))
    .join(" ");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function readPosition(value: unknown, key: "line" | "column"): Partial<ConsoleLocation> {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? { [key]: value } : {};
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/u);
  return cut >= 0 ? url.slice(0, cut) : url;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
