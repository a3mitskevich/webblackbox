import { CAPTURE_MODES, type CaptureMode, type ExportPolicy } from "@webblackbox/protocol";

import type {
  ContentRawEvent,
  ExtensionInboundMessage,
  FullModeVisualCapture
} from "../shared/messages.js";

/** Most events one `content.events` message may carry (the content script sends up to 120). */
export const CONTENT_EVENT_BATCH_MAX = 1_000;
/** Longer marker text is cut; markers are labels typed or chosen by the user. */
export const MARKER_MESSAGE_MAX_CHARS = 1_000;
const RAW_TYPE_MAX_CHARS = 64;
const ID_MAX_CHARS = 256;
const PASSPHRASE_MAX_CHARS = 4_096;
const NOTE_MAX_CHARS = 10_000;
const TAGS_MAX = 256;

const FULL_MODE_VISUAL_CAPTURES: ReadonlySet<string> = new Set<FullModeVisualCapture>([
  "screenshots",
  "recording",
  "both",
  "none"
]);
const CAPTURE_MODE_SET: ReadonlySet<string> = new Set(CAPTURE_MODES);

export type InboundParseResult =
  | {
      ok: true;
      message: ExtensionInboundMessage;
      /** `content.events` only: malformed events left out of the batch. */
      droppedEvents: number;
    }
  | { ok: false; kind: string; reason: string };

/** A field that is present but not of its expected shape. */
const INVALID = Symbol("invalid");
type Optional<T> = T | undefined | typeof INVALID;
type Guard<T> = (value: unknown) => value is T;

/**
 * Validates a message that reached the service worker from a content script or an extension page.
 * The sender chooses every byte of it, so each kind's fields are checked before use:
 * - a required field that is missing, or any field of the wrong type, rejects the message;
 * - an optional field set to `null` counts as absent (senders use it for "not set");
 * - unknown fields are left out: the result is a new object with the known fields only;
 * - `content.events` keeps its valid events and counts the dropped ones.
 */
export function parseExtensionInboundMessage(raw: unknown): InboundParseResult {
  const row = asRecord(raw);

  if (!row) {
    return reject("unknown", "not an object");
  }

  if (typeof row.kind !== "string") {
    return reject("unknown", "kind is not a string");
  }

  switch (row.kind) {
    case "ui.start":
      return parseUiStart(row);
    case "ui.stop":
      return parseUiStop(row);
    case "ui.export":
      return parseUiExport(row);
    case "ui.delete":
    case "ui.ack-profile-cancel":
    case "ui.dismiss-export":
    case "content.stop-drained":
      return parseSidOnly(row, row.kind);
    case "ui.annotate":
      return parseUiAnnotate(row);
    case "ui.request-session-list":
    case "ui.passphrase-status":
    case "ui.forget-passphrase":
    case "content.ready":
      return accept({ kind: row.kind });
    case "ui.resolve-profile":
      return parseUiResolveProfile(row);
    case "content.marker":
      return parseContentMarker(row);
    case "content.events":
      return parseContentEvents(row);
    default:
      // Logged: keep a sender-chosen string short.
      return reject(row.kind.slice(0, RAW_TYPE_MAX_CHARS), "unknown kind");
  }
}

function parseUiStart(row: Record<string, unknown>): InboundParseResult {
  const tabId = readOptional(row.tabId, isTabId);
  const reloadPage = readOptional(row.reloadPage, isBoolean);
  const visualCapture = readOptional(row.visualCapture, isFullModeVisualCapture);
  const profileId = readOptional(row.profileId, isId);
  const mode = readOptional(row.mode, isCaptureMode);

  if (mode === INVALID) {
    return reject("ui.start", "mode");
  }

  if (tabId === INVALID) {
    return reject("ui.start", "tabId");
  }

  if (reloadPage === INVALID) {
    return reject("ui.start", "reloadPage");
  }

  if (visualCapture === INVALID) {
    return reject("ui.start", "visualCapture");
  }

  if (profileId === INVALID) {
    return reject("ui.start", "profileId");
  }

  return accept({
    kind: "ui.start",
    ...defined({ mode, tabId, reloadPage, visualCapture, profileId })
  });
}

function parseUiStop(row: Record<string, unknown>): InboundParseResult {
  const tabId = readOptional(row.tabId, isTabId);

  if (tabId === INVALID) {
    return reject("ui.stop", "tabId");
  }

  return accept({ kind: "ui.stop", ...defined({ tabId }) });
}

function parseUiExport(row: Record<string, unknown>): InboundParseResult {
  const passphrase = readOptional(row.passphrase, isPassphrase);
  const saveAs = readOptional(row.saveAs, isBoolean);
  const policy =
    row.policy === undefined || row.policy === null ? undefined : parseExportPolicy(row.policy);

  if (!isId(row.sid)) {
    return reject("ui.export", "sid");
  }

  if (passphrase === INVALID) {
    return reject("ui.export", "passphrase");
  }

  if (saveAs === INVALID) {
    return reject("ui.export", "saveAs");
  }

  if (policy === INVALID) {
    return reject("ui.export", "policy");
  }

  return accept({ kind: "ui.export", sid: row.sid, ...defined({ passphrase, saveAs, policy }) });
}

/** The export limits the sender asks for; `resolveExportPolicy` clamps their ranges. */
function parseExportPolicy(value: unknown): Partial<ExportPolicy> | typeof INVALID {
  const row = asRecord(value);

  if (!row) {
    return INVALID;
  }

  const includeScreenshots = readOptional(row.includeScreenshots, isBoolean);
  const includeScreenRecordings = readOptional(row.includeScreenRecordings, isBoolean);
  const maxArchiveBytes = readOptional(row.maxArchiveBytes, isFiniteNumber);
  const recentWindowMs = readOptional(row.recentWindowMs, isFiniteNumber);

  if (
    includeScreenshots === INVALID ||
    includeScreenRecordings === INVALID ||
    maxArchiveBytes === INVALID ||
    recentWindowMs === INVALID
  ) {
    return INVALID;
  }

  return defined({ includeScreenshots, includeScreenRecordings, maxArchiveBytes, recentWindowMs });
}

function parseSidOnly(
  row: Record<string, unknown>,
  kind: "ui.delete" | "ui.ack-profile-cancel" | "ui.dismiss-export" | "content.stop-drained"
): InboundParseResult {
  return isId(row.sid) ? accept({ kind, sid: row.sid }) : reject(kind, "sid");
}

function parseUiAnnotate(row: Record<string, unknown>): InboundParseResult {
  const tags = readOptional(row.tags, isTagList);
  const note = readOptional(row.note, isNote);

  if (!isId(row.sid)) {
    return reject("ui.annotate", "sid");
  }

  if (tags === INVALID) {
    return reject("ui.annotate", "tags");
  }

  if (note === INVALID) {
    return reject("ui.annotate", "note");
  }

  return accept({ kind: "ui.annotate", sid: row.sid, ...defined({ tags, note }) });
}

function parseUiResolveProfile(row: Record<string, unknown>): InboundParseResult {
  const tabId = readOptional(row.tabId, isTabId);
  const profileId = readOptional(row.profileId, isId);

  if (tabId === INVALID) {
    return reject("ui.resolve-profile", "tabId");
  }

  if (profileId === INVALID) {
    return reject("ui.resolve-profile", "profileId");
  }

  return accept({ kind: "ui.resolve-profile", ...defined({ tabId, profileId }) });
}

function parseContentMarker(row: Record<string, unknown>): InboundParseResult {
  if (typeof row.message !== "string") {
    return reject("content.marker", "message");
  }

  return accept({
    kind: "content.marker",
    message: row.message.slice(0, MARKER_MESSAGE_MAX_CHARS)
  });
}

function parseContentEvents(row: Record<string, unknown>): InboundParseResult {
  if (!Array.isArray(row.events)) {
    return reject("content.events", "events");
  }

  if (row.events.length > CONTENT_EVENT_BATCH_MAX) {
    return reject("content.events", "too many events");
  }

  const events: ContentRawEvent[] = [];

  for (const candidate of row.events) {
    const event = parseContentRawEvent(candidate);

    if (event) {
      events.push(event);
    }
  }

  return accept({ kind: "content.events", events }, row.events.length - events.length);
}

/** Only content events: a content script cannot pass for CDP or the service worker itself. */
function parseContentRawEvent(value: unknown): ContentRawEvent | null {
  const row = asRecord(value);

  if (
    !row ||
    row.source !== "content" ||
    !isRawType(row.rawType) ||
    !isShortString(row.sid) ||
    !isFiniteNumber(row.t) ||
    !isFiniteNumber(row.mono) ||
    row.payload === undefined
  ) {
    return null;
  }

  const nav = readOptional(row.nav, isShortString);
  const frame = readOptional(row.frame, isShortString);

  if (nav === INVALID || frame === INVALID) {
    return null;
  }

  return {
    source: "content",
    rawType: row.rawType,
    sid: row.sid,
    t: row.t,
    mono: row.mono,
    ...defined({ nav, frame }),
    payload: row.payload
  };
}

function accept(message: ExtensionInboundMessage, droppedEvents = 0): InboundParseResult {
  return { ok: true, message, droppedEvents };
}

function reject(kind: string, reason: string): InboundParseResult {
  return { ok: false, kind, reason };
}

function readOptional<T>(value: unknown, guard: Guard<T>): Optional<T> {
  if (value === undefined || value === null) {
    return undefined;
  }

  return guard(value) ? value : INVALID;
}

/** The entries whose value is set: an optional field stays absent rather than `undefined`. */
function defined<T extends Record<string, unknown>>(
  fields: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === "string" && CAPTURE_MODE_SET.has(value);
}

function isFullModeVisualCapture(value: unknown): value is FullModeVisualCapture {
  return typeof value === "string" && FULL_MODE_VISUAL_CAPTURES.has(value);
}

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length <= ID_MAX_CHARS;
}

/** A session or profile id: non-empty and short. */
function isId(value: unknown): value is string {
  return isShortString(value) && value.length > 0;
}

function isRawType(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= RAW_TYPE_MAX_CHARS;
}

/** Any length up to the cap; `exportSession` enforces the minimum with a message for the user. */
function isPassphrase(value: unknown): value is string {
  return typeof value === "string" && value.length <= PASSPHRASE_MAX_CHARS;
}

function isNote(value: unknown): value is string {
  return typeof value === "string" && value.length <= NOTE_MAX_CHARS;
}

function isTagList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= TAGS_MAX &&
    value.every((tag) => typeof tag === "string" && tag.length <= ID_MAX_CHARS)
  );
}

/** At most this many dropped-message warnings per window; the rest are only counted. */
export const REJECTED_MESSAGE_LOG_MAX_PER_WINDOW = 5;
export const REJECTED_MESSAGE_LOG_WINDOW_MS = 10_000;

export type RejectedMessageDetails = {
  kind: string;
  reason: string;
  port?: string;
  tabId?: number;
  frameId?: number;
  /** Events left out of an accepted `content.events` batch. */
  droppedEvents?: number;
};

export type RejectedMessageLog = (details: RejectedMessageDetails) => void;

/**
 * Warns about dropped inbound messages without letting a misbehaving sender flood the worker's
 * console: a few warnings per window, then a count of the suppressed ones with the next warning.
 */
export function createRejectedMessageLog(deps: {
  now: () => number;
  warn: (message: string, details: Record<string, unknown>) => void;
}): RejectedMessageLog {
  let windowStartedAt = Number.NEGATIVE_INFINITY;
  let loggedInWindow = 0;
  let suppressed = 0;

  return (details) => {
    const now = deps.now();

    if (now - windowStartedAt >= REJECTED_MESSAGE_LOG_WINDOW_MS) {
      windowStartedAt = now;
      loggedInWindow = 0;
    }

    if (loggedInWindow >= REJECTED_MESSAGE_LOG_MAX_PER_WINDOW) {
      suppressed += 1;
      return;
    }

    loggedInWindow += 1;
    deps.warn("[WebBlackbox] dropped an inbound message", {
      ...details,
      ...(suppressed > 0 ? { suppressedBefore: suppressed } : {})
    });
    suppressed = 0;
  };
}
