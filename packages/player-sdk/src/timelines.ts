import type { WebBlackboxEvent, WebBlackboxEventType } from "@webblackbox/protocol";

import type { PerformanceArtifactEntry, StorageTimelineEntry } from "./types.js";
import { asNumber, asRecord, asString } from "./value-readers.js";

const STORAGE_EVENT_PREFIXES = [
  "storage.cookie.",
  "storage.local.",
  "storage.session.",
  "storage.idb.",
  "storage.cache.",
  "storage.sw."
] as const;

export function buildStorageTimeline(events: WebBlackboxEvent[]): StorageTimelineEntry[] {
  return events
    .filter((event) => STORAGE_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix)))
    .map((event) => {
      const payload = asRecord(event.data);

      return {
        eventId: event.id,
        eventType: event.type,
        t: event.t,
        mono: event.mono,
        kind: detectStorageKind(event.type),
        operation: asString(payload?.op),
        hash: asString(payload?.hash) ?? asString(payload?.schemaHash),
        mode: asString(payload?.mode),
        count: asNumber(payload?.count),
        reason: asString(payload?.reason),
        snapshot: payload
      };
    })
    .sort((left, right) => left.mono - right.mono);
}

export function buildPerformanceArtifacts(events: WebBlackboxEvent[]): PerformanceArtifactEntry[] {
  return events
    .filter((event) => event.type.startsWith("perf."))
    .map((event) => {
      const payload = asRecord(event.data);

      return {
        eventId: event.id,
        eventType: event.type,
        t: event.t,
        mono: event.mono,
        kind: detectPerformanceKind(event.type),
        hash:
          asString(payload?.traceHash) ??
          asString(payload?.profileHash) ??
          asString(payload?.snapshotHash) ??
          asString(payload?.contentHash),
        size: asNumber(payload?.size) ?? asNumber(payload?.sampledSize),
        reason: asString(payload?.reason),
        snapshot: payload
      };
    })
    .sort((left, right) => left.mono - right.mono);
}

function detectStorageKind(type: WebBlackboxEventType): StorageTimelineEntry["kind"] {
  if (type.startsWith("storage.cookie.")) {
    return "cookie";
  }

  if (type.startsWith("storage.local.")) {
    return "local";
  }

  if (type.startsWith("storage.session.")) {
    return "session";
  }

  if (type.startsWith("storage.idb.")) {
    return "idb";
  }

  if (type.startsWith("storage.cache.")) {
    return "cache";
  }

  if (type.startsWith("storage.sw.")) {
    return "sw";
  }

  return "unknown";
}

function detectPerformanceKind(type: WebBlackboxEventType): PerformanceArtifactEntry["kind"] {
  if (type === "perf.trace") {
    return "trace";
  }

  if (type === "perf.cpu.profile") {
    return "cpu";
  }

  if (type === "perf.heap.snapshot") {
    return "heap";
  }

  if (type === "perf.longtask") {
    return "longtask";
  }

  if (type === "perf.vitals") {
    return "vitals";
  }

  return "other";
}
