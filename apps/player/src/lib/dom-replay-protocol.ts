// Messages between the Player and the DOM replay frame (`public/replay/index.html`, spike task
// 56). Both sides check the message source (the frame's window / `window.parent`) and origin, and
// validate every message: the frame renders untrusted archive content and must not be able to
// drive the Player beyond these replies.

import type { RrwebRecordedEvent } from "@webblackbox/protocol";

export const DOM_REPLAY_FRAME_PATH = "./replay/index.html";

/** Where messages to the other side may go: this origin, or anywhere when it is opaque (file:). */
export function replayTargetOrigin(origin: string): string {
  return origin === "null" ? "*" : origin;
}

/** A response body from the archive that the replay may use instead of the live URL. */
export type DomReplayResource = {
  url: string;
  mime: string;
  blob: Blob;
};

export type PlayerToFrameMessage =
  | { type: "wb-replay/load"; events: RrwebRecordedEvent[]; resources: DomReplayResource[] }
  | { type: "wb-replay/seek"; timestamp: number; highlightNodeId: number | null };

export type DomReplayRect = { x: number; y: number; width: number; height: number };

export type FrameToPlayerMessage =
  | { type: "wb-replay/ready" }
  | {
      type: "wb-replay/loaded";
      eventCount: number;
      resolvedResources: number;
      unresolvedUrls: string[];
    }
  | {
      type: "wb-replay/highlight";
      nodeId: number;
      found: boolean;
      tagName: string | null;
      rect: DomReplayRect | null;
    }
  /** A seek finished; the time rrweb took to rebuild the DOM at that moment. */
  | { type: "wb-replay/seeked"; timestamp: number; durationMs: number }
  | { type: "wb-replay/error"; message: string };

/** Unresolved URLs the frame reports back at most (the rest only count). */
export const DOM_REPLAY_MAX_REPORTED_URLS = 50;
const MAX_TEXT = 500;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isRecordedEvent(value: unknown): value is RrwebRecordedEvent {
  const record = asRecord(value);
  return record !== null && isFiniteNumber(record.type) && isFiniteNumber(record.timestamp);
}

function isResource(value: unknown): value is DomReplayResource {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.url === "string" &&
    typeof record.mime === "string" &&
    typeof Blob !== "undefined" &&
    record.blob instanceof Blob
  );
}

/** A message from the Player as the frame accepts it, or null. */
export function parsePlayerToFrameMessage(value: unknown): PlayerToFrameMessage | null {
  const record = asRecord(value);

  if (record?.type === "wb-replay/load") {
    return Array.isArray(record.events) &&
      record.events.every(isRecordedEvent) &&
      Array.isArray(record.resources) &&
      record.resources.every(isResource)
      ? { type: record.type, events: record.events, resources: record.resources }
      : null;
  }

  if (record?.type === "wb-replay/seek") {
    const nodeId = record.highlightNodeId;
    return isFiniteNumber(record.timestamp) && (nodeId === null || isFiniteNumber(nodeId))
      ? { type: record.type, timestamp: record.timestamp, highlightNodeId: nodeId }
      : null;
  }

  return null;
}

function parseRect(value: unknown): DomReplayRect | null {
  const record = asRecord(value);
  return record &&
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isFiniteNumber(record.width) &&
    isFiniteNumber(record.height)
    ? { x: record.x, y: record.y, width: record.width, height: record.height }
    : null;
}

/** A reply from the frame as the Player accepts it, or null. Strings are capped. */
export function parseFrameToPlayerMessage(value: unknown): FrameToPlayerMessage | null {
  const record = asRecord(value);

  switch (record?.type) {
    case "wb-replay/ready":
      return { type: record.type };
    case "wb-replay/loaded":
      return isFiniteNumber(record.eventCount) &&
        isFiniteNumber(record.resolvedResources) &&
        Array.isArray(record.unresolvedUrls)
        ? {
            type: record.type,
            eventCount: record.eventCount,
            resolvedResources: record.resolvedResources,
            unresolvedUrls: record.unresolvedUrls
              .filter((url): url is string => typeof url === "string")
              .slice(0, DOM_REPLAY_MAX_REPORTED_URLS)
              .map((url) => url.slice(0, MAX_TEXT))
          }
        : null;
    case "wb-replay/highlight":
      return isFiniteNumber(record.nodeId) && typeof record.found === "boolean"
        ? {
            type: record.type,
            nodeId: record.nodeId,
            found: record.found,
            tagName: typeof record.tagName === "string" ? record.tagName.slice(0, 64) : null,
            rect: parseRect(record.rect)
          }
        : null;
    case "wb-replay/seeked":
      return isFiniteNumber(record.timestamp) && isFiniteNumber(record.durationMs)
        ? { type: record.type, timestamp: record.timestamp, durationMs: record.durationMs }
        : null;
    case "wb-replay/error":
      return typeof record.message === "string"
        ? { type: record.type, message: record.message.slice(0, MAX_TEXT) }
        : null;
    default:
      return null;
  }
}
