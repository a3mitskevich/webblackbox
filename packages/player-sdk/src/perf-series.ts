import type { WebBlackboxEvent } from "@webblackbox/protocol";

/** Web vitals the page reported (the latest value of each at or before a moment). */
export type WebVitals = {
  /** Largest contentful paint, ms from navigation start. */
  lcp?: number;
  /** Cumulative layout shift (sum of shift values). */
  cls?: number;
  /** Interaction to next paint, ms. */
  inp?: number;
  /** First input delay, ms. */
  fid?: number;
  /** Time to first byte, ms. */
  ttfb?: number;
};

export type LongTaskEntry = {
  eventId: string;
  mono: number;
  durationMs: number;
  name?: string;
};

/** The request fields the series read (a `NetworkWaterfallEntry` fits). */
export type PerformanceSeriesRequest = {
  startMono: number;
  endMono: number;
  failed: boolean;
  status?: number;
  encodedDataLength?: number;
};

/** Time buckets over the whole session (canvas chart input: one array per series). */
export type PerformanceSeries = {
  bucketMs: number;
  /** Bucket start, ms from the session start. */
  offsets: number[];
  /** Requests open during the bucket. */
  requestsInFlight: number[];
  /** Response bytes of requests that finished in the bucket, in KiB. */
  transferKib: number[];
  /** Requests that finished failed (or with status ≥ 400) in the bucket. */
  failedRequests: number[];
  /** Total long-task time that started in the bucket, ms. */
  longTaskMs: number[];
};

export type PerformanceSeriesInput = {
  events: readonly WebBlackboxEvent[];
  requests: readonly PerformanceSeriesRequest[];
  minMono: number;
  maxMono: number;
  /** Target bucket count (default 240); buckets are at least `minBucketMs` long. */
  buckets?: number;
  minBucketMs?: number;
};

const DEFAULT_BUCKETS = 240;
const DEFAULT_MIN_BUCKET_MS = 50;
const MAX_BUCKETS = 2_000;
const VITAL_KEYS = ["lcp", "cls", "inp", "fid", "ttfb"] as const;

const METRIC_KEYS: Readonly<Record<string, keyof WebVitals>> = {
  "largest-contentful-paint": "lcp",
  "layout-shift": "cls",
  "first-input": "fid",
  "event-timing": "inp",
  navigation: "ttfb"
};

/** Long tasks in time order (`perf.longtask` events with a duration). */
export function readLongTasks(events: readonly WebBlackboxEvent[]): LongTaskEntry[] {
  return events.flatMap((event): LongTaskEntry[] => {
    if (event.type !== "perf.longtask") {
      return [];
    }

    const data = asRecord(event.data);
    const durationMs = asNumber(data?.duration) ?? asNumber(data?.durationMs);
    const name = typeof data?.name === "string" && data.name ? data.name : undefined;

    return durationMs !== null && durationMs >= 0
      ? [{ eventId: event.id, mono: event.mono, durationMs, ...(name ? { name } : {}) }]
      : [];
  });
}

/**
 * The web vitals reported up to `atMono` (all of them without it). Reads both the summary shape
 * (`{ lcp, cls, inp, fid, ttfb }`) and the page agent's per-entry shape
 * (`{ metric: "largest-contentful-paint" | "layout-shift" | "first-input", value, startTime }`).
 */
export function readWebVitals(
  events: readonly WebBlackboxEvent[],
  atMono = Number.POSITIVE_INFINITY
): WebVitals {
  let vitals: WebVitals = {};

  for (const event of events) {
    if (event.mono > atMono) {
      break;
    }

    if (event.type === "perf.vitals") {
      vitals = mergeVitals(vitals, asRecord(event.data));
    }
  }

  return vitals;
}

/** Bucketed series for the Perf charts. Requests and events must use the same clock. */
export function buildPerformanceSeries(input: PerformanceSeriesInput): PerformanceSeries {
  const span = Math.max(0, input.maxMono - input.minMono);
  const target = Math.min(MAX_BUCKETS, Math.max(1, Math.round(input.buckets ?? DEFAULT_BUCKETS)));
  const bucketMs = Math.max(input.minBucketMs ?? DEFAULT_MIN_BUCKET_MS, Math.ceil(span / target));
  const count = Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(span / bucketMs)));
  const indexOf = (mono: number): number =>
    Math.min(count - 1, Math.max(0, Math.floor((mono - input.minMono) / bucketMs)));
  const opened = new Array<number>(count + 1).fill(0);
  const transferBytes = new Array<number>(count).fill(0);
  const failedRequests = new Array<number>(count).fill(0);
  const longTaskMs = new Array<number>(count).fill(0);

  for (const request of input.requests) {
    const start = indexOf(request.startMono);
    const end = indexOf(Math.max(request.startMono, request.endMono));
    opened[start] = (opened[start] ?? 0) + 1;
    opened[end + 1] = (opened[end + 1] ?? 0) - 1;
    transferBytes[end] = (transferBytes[end] ?? 0) + (request.encodedDataLength ?? 0);

    if (request.failed || (request.status ?? 0) >= 400) {
      failedRequests[end] = (failedRequests[end] ?? 0) + 1;
    }
  }

  for (const task of readLongTasks(input.events)) {
    const index = indexOf(task.mono);
    longTaskMs[index] = (longTaskMs[index] ?? 0) + task.durationMs;
  }

  const requestsInFlight = runningSum(opened).slice(0, count);

  return {
    bucketMs,
    offsets: Array.from({ length: count }, (_, index) => index * bucketMs),
    requestsInFlight,
    transferKib: transferBytes.map((bytes) => roundTenth(bytes / 1024)),
    failedRequests,
    longTaskMs: longTaskMs.map(roundTenth)
  };
}

function runningSum(values: readonly number[]): number[] {
  let total = 0;
  return values.map((value) => (total += value));
}

function mergeVitals(vitals: WebVitals, data: Record<string, unknown> | null): WebVitals {
  if (!data) {
    return vitals;
  }

  const summary = VITAL_KEYS.reduce<WebVitals>((next, key) => {
    const value = asNumber(data[key]);
    return value === null ? next : { ...next, [key]: value };
  }, vitals);
  const metric = typeof data.metric === "string" ? METRIC_KEYS[data.metric] : undefined;

  if (!metric) {
    return summary;
  }

  if (metric === "cls") {
    const shift = asNumber(data.value);
    return shift === null ? summary : { ...summary, cls: (summary.cls ?? 0) + shift };
  }

  if (metric === "fid" || metric === "inp") {
    const duration = asNumber(data.duration) ?? asNumber(data.value);
    return duration === null
      ? summary
      : { ...summary, [metric]: Math.max(summary[metric] ?? 0, duration) };
  }

  const time = asNumber(data.value) ?? asNumber(data.startTime);
  return time === null ? summary : { ...summary, [metric]: time };
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
