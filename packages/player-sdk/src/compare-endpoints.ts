/** The request fields endpoint alignment reads (a `NetworkWaterfallEntry` fits). */
export type CompareRequest = {
  reqId: string;
  method: string;
  url: string;
  startMono: number;
  durationMs: number;
  failed: boolean;
  status?: number;
  responseBodyHash?: string;
};

/** One endpoint (`METHOD host/path`) in one session. */
export type EndpointSummary = {
  key: string;
  method: string;
  path: string;
  count: number;
  failureCount: number;
  p95Ms: number;
  firstStartMono: number;
  /** The first request of the endpoint (for header diffs). */
  firstReqId: string;
  /** The first request of the endpoint that kept a response body (for body diffs). */
  firstBodyReqId?: string;
};

/**
 * How an endpoint changed from session A to B: a higher failure rate (`regressed`), a clearly
 * slower p95 (`slower`), only in B (`new`), only in A (`missing`), otherwise `stable`.
 */
export type EndpointSignal = "regressed" | "slower" | "new" | "missing" | "stable";

export type EndpointAlignment = {
  key: string;
  left: EndpointSummary | null;
  right: EndpointSummary | null;
  signal: EndpointSignal;
};

/** A p95 counts as slower when it grows by this factor and by at least `SLOWER_MIN_DELTA_MS`. */
export const SLOWER_P95_FACTOR = 1.5;
export const SLOWER_MIN_DELTA_MS = 100;

/** Requests grouped by `METHOD host/path` (the query string is ignored: it often carries ids). */
export function summarizeEndpoints(
  requests: readonly CompareRequest[]
): Map<string, EndpointSummary> {
  const groups = new Map<string, CompareRequest[]>();

  for (const request of requests) {
    const key = endpointKey(request);
    groups.set(key, [...(groups.get(key) ?? []), request]);
  }

  return new Map(
    [...groups.entries()].map(([key, bucket]): [string, EndpointSummary] => [
      key,
      summarizeBucket(key, bucket)
    ])
  );
}

/**
 * Endpoints of both sessions side by side, ordered by their first appearance relative to each
 * session's start, so the table reads like the two recordings' network order.
 */
export function alignEndpoints(
  left: readonly CompareRequest[],
  right: readonly CompareRequest[]
): EndpointAlignment[] {
  const leftSummary = summarizeEndpoints(left);
  const rightSummary = summarizeEndpoints(right);
  const leftStart = earliestStart(left);
  const rightStart = earliestStart(right);
  const keys = new Set([...leftSummary.keys(), ...rightSummary.keys()]);

  return [...keys]
    .map((key) => {
      const a = leftSummary.get(key) ?? null;
      const b = rightSummary.get(key) ?? null;
      const rank = Math.min(
        a ? a.firstStartMono - leftStart : Number.POSITIVE_INFINITY,
        b ? b.firstStartMono - rightStart : Number.POSITIVE_INFINITY
      );

      return { alignment: { key, left: a, right: b, signal: readSignal(a, b) }, rank };
    })
    .sort((x, y) => x.rank - y.rank || x.alignment.key.localeCompare(y.alignment.key))
    .map((row) => row.alignment);
}

/** `GET host/path` of a request. */
export function endpointKey(request: Pick<CompareRequest, "method" | "url">): string {
  return `${request.method.toUpperCase()} ${endpointPath(request.url)}`;
}

function summarizeBucket(key: string, bucket: readonly CompareRequest[]): EndpointSummary {
  const ordered = [...bucket].sort((left, right) => left.startMono - right.startMono);
  const first = ordered[0] as CompareRequest;
  const withBody = ordered.find((request) => request.responseBodyHash);

  return {
    key,
    method: first.method.toUpperCase(),
    path: endpointPath(first.url),
    count: ordered.length,
    failureCount: ordered.filter(isFailed).length,
    p95Ms: percentile95(ordered.map((request) => request.durationMs)),
    firstStartMono: first.startMono,
    firstReqId: first.reqId,
    ...(withBody ? { firstBodyReqId: withBody.reqId } : {})
  };
}

function readSignal(left: EndpointSummary | null, right: EndpointSummary | null): EndpointSignal {
  if (!left) {
    return "new";
  }

  if (!right) {
    return "missing";
  }

  if (right.failureCount / right.count > left.failureCount / left.count) {
    return "regressed";
  }

  const isSlower =
    right.p95Ms >= left.p95Ms * SLOWER_P95_FACTOR &&
    right.p95Ms - left.p95Ms >= SLOWER_MIN_DELTA_MS;

  return isSlower ? "slower" : "stable";
}

function earliestStart(requests: readonly CompareRequest[]): number {
  return requests.reduce(
    (earliest, request) => Math.min(earliest, request.startMono),
    Number.POSITIVE_INFINITY
  );
}

function isFailed(request: CompareRequest): boolean {
  return request.failed || (request.status ?? 0) >= 400;
}

function percentile95(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function endpointPath(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.protocol === "http:" || url.protocol === "https:" ? url.host : "";
    return `${host}${url.pathname}`;
  } catch {
    const cut = raw.search(/[?#]/u);
    return cut >= 0 ? raw.slice(0, cut) : raw;
  }
}
