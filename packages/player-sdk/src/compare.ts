import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { isErrorEvent } from "./event-query.js";
import type { WebBlackboxPlayer } from "./index.js";
import type {
  NetworkWaterfallEntry,
  PlayerComparison,
  StorageComparison,
  StorageTimelineEntry
} from "./types.js";
import { roundTo } from "./value-readers.js";

export function comparePlayers(
  player: Pick<WebBlackboxPlayer, "events" | "getNetworkWaterfall" | "archive">,
  other: Pick<WebBlackboxPlayer, "events" | "getNetworkWaterfall" | "archive">
): PlayerComparison {
  const leftEvents = player.events;
  const rightEvents = other.events;
  const leftCounts = buildTypeCounts(leftEvents);
  const rightCounts = buildTypeCounts(rightEvents);
  const types = new Set([...leftCounts.keys(), ...rightCounts.keys()]);

  const typeDeltas = [...types]
    .map((type) => {
      const left = leftCounts.get(type) ?? 0;
      const right = rightCounts.get(type) ?? 0;

      return {
        type,
        left,
        right,
        delta: right - left
      };
    })
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  const endpointRegressions = buildEndpointRegressions(
    player.getNetworkWaterfall(),
    other.getNetworkWaterfall()
  );

  const leftSessionId = leftEvents[0]?.sid ?? player.archive.manifest.site.origin;
  const rightSessionId = rightEvents[0]?.sid ?? other.archive.manifest.site.origin;

  return {
    leftSessionId,
    rightSessionId,
    leftSid: leftSessionId,
    rightSid: rightSessionId,
    eventDelta: rightEvents.length - leftEvents.length,
    errorDelta: rightEvents.filter(isErrorEvent).length - leftEvents.filter(isErrorEvent).length,
    requestDelta:
      rightEvents.filter((event) => event.type === "network.request").length -
      leftEvents.filter((event) => event.type === "network.request").length,
    durationDeltaMs: computeDuration(rightEvents) - computeDuration(leftEvents),
    typeDeltas,
    endpointRegressions
  };
}

export function compareStorageTimelines(
  player: Pick<WebBlackboxPlayer, "getStorageTimeline">,
  other: Pick<WebBlackboxPlayer, "getStorageTimeline">
): StorageComparison {
  const left = player.getStorageTimeline();
  const right = other.getStorageTimeline();

  const kinds: Array<StorageTimelineEntry["kind"]> = [
    "cookie",
    "local",
    "session",
    "idb",
    "cache",
    "sw",
    "unknown"
  ];

  const kindDeltas = kinds.map((kind) => {
    const leftCount = left.filter((entry) => entry.kind === kind).length;
    const rightCount = right.filter((entry) => entry.kind === kind).length;

    return {
      kind,
      left: leftCount,
      right: rightCount,
      delta: rightCount - leftCount
    };
  });

  const leftHashes = new Set(
    left.map((entry) => entry.hash).filter((value): value is string => Boolean(value))
  );
  const rightHashes = new Set(
    right.map((entry) => entry.hash).filter((value): value is string => Boolean(value))
  );

  const hashOnlyLeft = [...leftHashes].filter((hash) => !rightHashes.has(hash)).sort();
  const hashOnlyRight = [...rightHashes].filter((hash) => !leftHashes.has(hash)).sort();

  return {
    leftEvents: left.length,
    rightEvents: right.length,
    kindDeltas,
    hashOnlyLeft,
    hashOnlyRight
  };
}

function buildTypeCounts(events: WebBlackboxEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  return counts;
}

function computeDuration(events: WebBlackboxEvent[]): number {
  if (events.length === 0) {
    return 0;
  }

  const sorted = [...events].sort((left, right) => left.mono - right.mono);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  if (!first || !last) {
    return 0;
  }

  return Math.max(0, last.mono - first.mono);
}

function buildEndpointRegressions(
  leftEntries: NetworkWaterfallEntry[],
  rightEntries: NetworkWaterfallEntry[]
): PlayerComparison["endpointRegressions"] {
  const leftStats = buildEndpointStats(leftEntries);
  const rightStats = buildEndpointStats(rightEntries);
  const keys = new Set([...leftStats.keys(), ...rightStats.keys()]);
  const regressions: PlayerComparison["endpointRegressions"] = [];

  for (const key of keys) {
    const left = leftStats.get(key) ?? emptyEndpointStatFromKey(key);
    const right = rightStats.get(key) ?? emptyEndpointStatFromKey(key);
    const leftFailureRate = roundTo(left.count > 0 ? left.failed / left.count : 0, 4);
    const rightFailureRate = roundTo(right.count > 0 ? right.failed / right.count : 0, 4);
    const leftP95DurationMs = roundTo(percentile(left.durations, 95), 2);
    const rightP95DurationMs = roundTo(percentile(right.durations, 95), 2);
    const countDelta = right.count - left.count;
    const failedDelta = right.failed - left.failed;
    const failureRateDelta = roundTo(rightFailureRate - leftFailureRate, 4);
    const p95DurationDeltaMs = roundTo(rightP95DurationMs - leftP95DurationMs, 2);

    if (
      countDelta === 0 &&
      failedDelta === 0 &&
      failureRateDelta === 0 &&
      p95DurationDeltaMs === 0
    ) {
      continue;
    }

    regressions.push({
      endpoint: left.endpoint,
      method: left.method,
      leftCount: left.count,
      rightCount: right.count,
      countDelta,
      leftFailed: left.failed,
      rightFailed: right.failed,
      failedDelta,
      leftFailureRate,
      rightFailureRate,
      failureRateDelta,
      leftP95DurationMs,
      rightP95DurationMs,
      p95DurationDeltaMs
    });
  }

  return regressions.sort(
    (left, right) =>
      Math.abs(right.failureRateDelta) - Math.abs(left.failureRateDelta) ||
      Math.abs(right.p95DurationDeltaMs) - Math.abs(left.p95DurationDeltaMs) ||
      Math.abs(right.countDelta) - Math.abs(left.countDelta) ||
      left.method.localeCompare(right.method) ||
      left.endpoint.localeCompare(right.endpoint)
  );
}

type EndpointStat = {
  endpoint: string;
  method: string;
  count: number;
  failed: number;
  durations: number[];
};

function buildEndpointStats(entries: NetworkWaterfallEntry[]): Map<string, EndpointStat> {
  const stats = new Map<string, EndpointStat>();

  for (const entry of entries) {
    const key = toEndpointKey(entry.method, entry.url);
    const current = stats.get(key);

    if (!current) {
      stats.set(key, {
        endpoint: normalizeEndpoint(entry.url),
        method: entry.method.toUpperCase(),
        count: 1,
        failed: isFailedNetworkEntry(entry) ? 1 : 0,
        durations: [entry.durationMs]
      });
      continue;
    }

    current.count += 1;
    current.failed += isFailedNetworkEntry(entry) ? 1 : 0;
    current.durations.push(entry.durationMs);
  }

  return stats;
}

function emptyEndpointStatFromKey(key: string): EndpointStat {
  const [method = "GET", ...rest] = key.split(" ");
  return {
    endpoint: rest.join(" "),
    method,
    count: 0,
    failed: 0,
    durations: []
  };
}

function toEndpointKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${normalizeEndpoint(url)}`;
}

function normalizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const queryIndex = url.indexOf("?");
    return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  }
}

function isFailedNetworkEntry(entry: { failed: boolean; status?: number }): boolean {
  return entry.failed || (typeof entry.status === "number" && entry.status >= 400);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}
