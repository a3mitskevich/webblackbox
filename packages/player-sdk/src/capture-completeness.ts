import {
  isTextualMimeType,
  normalizeMimeType,
  type ArchiveTruncation,
  type BodySkipReason,
  type ExportManifest,
  type SessionInterruption,
  type WebBlackboxEvent,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import { readCaptureFallback, type CaptureFallbackInfo } from "./recording-profile.js";

/** The waterfall fields the completeness report reads. */
export type CompletenessNetworkEntry = {
  reqId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  failed: boolean;
  pending?: true;
  requestHeaders: Record<string, string>;
  requestHasBody?: true;
  requestBodyText?: string;
  requestBodyTruncated?: true;
  requestBodySkipReason?: BodySkipReason;
  responseBodyHash?: string;
  responseBodyTruncated?: true;
  responseBodySkip?: { reason: BodySkipReason };
};

/** The realtime timeline fields the completeness report reads. */
export type CompletenessRealtimeEntry = {
  eventType: WebBlackboxEventType;
  payloadLength?: number;
  payloadPreview?: string;
  payloadHash?: string;
  payloadTruncated?: boolean;
};

export type CompletenessInput = {
  events: readonly WebBlackboxEvent[];
  waterfall: readonly CompletenessNetworkEntry[];
  realtime: readonly CompletenessRealtimeEntry[];
  /** The archive manifest: what the export kept and whether the recording was interrupted. */
  manifest?: Pick<ExportManifest, "completeness" | "stats">;
  /**
   * The archive's Full → Light fallback, read from all its events (a range may leave the
   * `meta.config` that records it out); read from `events` when absent.
   */
  captureFallback?: CaptureFallbackInfo | null;
};

/** What the export kept of the stored recording, and how the recording ended. */
export type ExportCompleteness = {
  /** False for archives written before exports recorded what they left out. */
  recorded: boolean;
  /** Nothing stored was left out (unknown, so false, when not recorded). */
  whole: boolean;
  /** Events stored for the session at export time; null when not recorded. */
  storedEvents: number | null;
  exportedEvents: number;
  truncations: ArchiveTruncation[];
  /** Set when the recording ended without Stop. */
  interruption: SessionInterruption | null;
};

/** How many bodies the policy asked for and what happened to each of them. */
export type BodyCompleteness = {
  /** Bodies the policy asked for (textual, with bytes to keep). */
  expected: number;
  captured: number;
  /** Not captured, with a recorded reason. */
  skipped: number;
  /** Not captured and nothing says why: a silent loss. */
  missing: number;
  /** Captured as a prefix cut at the profile limit. */
  truncated: number;
  skipReasons: Partial<Record<BodySkipReason, number>>;
  /** Up to {@link MAX_MISSING_SAMPLES} silent losses. */
  missingSamples: Array<{
    reqId: string;
    method: string;
    url: string;
    status?: number;
    mimeType?: string;
  }>;
};

export type ResponseBodyCompleteness = BodyCompleteness & {
  byMime: Record<string, MimeCompleteness>;
  /** Textual `data:` URL responses: the body is the URL itself, so none is expected. */
  dataUrls: number;
};

export type MimeCompleteness = {
  expected: number;
  captured: number;
  skipped: number;
  missing: number;
};

export type CaptureCompletenessReport = {
  durationMs: number;
  export: ExportCompleteness;
  /**
   * When and why the recording left the Full engine and went on in Light; everything Full-only
   * (bodies, full console, screenshots, DevTools data) is missing after `at`. Null otherwise.
   */
  captureFallback: CaptureFallbackInfo | null;
  /** The archive's capture policy asked for request and response bodies (`body-allowlist`). */
  bodiesRequested: boolean;
  network: {
    requests: number;
    /** Requests to extension or browser-internal URLs still in the archive. */
    internalRequests: number;
    responseBodies: ResponseBodyCompleteness;
    requestBodies: BodyCompleteness;
  };
  dom: {
    snapshots: number;
    mutationBatches: number;
    rrwebEvents: number;
    /** Snapshot reasons (`start`, `interval`, `mutation`, ...) and how often each occurs. */
    snapshotReasons: Record<string, number>;
    /** Time from the first to the last DOM event, over the session duration (0..1). */
    coverage: number;
    /** Longest stretch without any DOM event, including the session start and end. */
    longestGapMs: number;
    /** Accessibility snapshots (`dom.a11y.snapshot`) and how many were cut by their budget. */
    a11ySnapshots: number;
    a11yTruncated: number;
    /** Snapshot triggers the per-minute cap left without a snapshot. */
    a11yDroppedTriggers: number;
  };
  realtime: {
    wsFrames: number;
    sseMessages: number;
    /** Frames whose stored text is a cut prefix. */
    truncatedFrames: number;
    /** Frames whose stored text is shorter than the frame and not flagged as cut. */
    incompleteFrames: number;
  };
  console: {
    entries: number;
    errors: number;
    withStack: number;
    truncated: number;
  };
  storage: {
    cookieSnapshots: number;
    cookieValues: number;
    localSnapshots: number;
    localValues: number;
    idbSnapshots: number;
    idbRecords: number;
  };
  perf: {
    vitals: number;
    longTasks: number;
    traces: number;
  };
};

export const MAX_MISSING_SAMPLES = 20;

const BODYLESS_STATUSES = new Set([101, 204, 205]);
const BROWSER_INTERNAL_URL =
  /^(chrome-extension|moz-extension|safari-web-extension|chrome|chrome-untrusted|devtools):/i;
const DATA_URL = /^data:/i;
const DOM_CHANGE_EVENT_TYPES = new Set<WebBlackboxEventType>([
  "dom.snapshot",
  "dom.mutation.batch",
  "dom.rrweb.event",
  "dom.diff"
]);

/**
 * What the archive holds against what its capture policy asked for: bodies (every loss either
 * explained by `network.body.skipped` / `request.postDataSkipped` or counted as missing), DOM
 * changes over the session, WebSocket frames, console, storage and perf signals.
 */
export function buildCaptureCompletenessReport(
  input: CompletenessInput
): CaptureCompletenessReport {
  const { events } = input;
  const startMono = events[0]?.mono ?? 0;
  const endMono = events[events.length - 1]?.mono ?? startMono;

  return {
    durationMs: Math.max(0, endMono - startMono),
    export: readExportCompleteness(input.manifest, events.length),
    captureFallback:
      input.captureFallback !== undefined ? input.captureFallback : readCaptureFallback(events),
    bodiesRequested: readNetworkPolicy(events) === "body-allowlist",
    network: {
      requests: input.waterfall.length,
      internalRequests: input.waterfall.filter((entry) => BROWSER_INTERNAL_URL.test(entry.url))
        .length,
      responseBodies: summarizeResponseBodies(input.waterfall),
      requestBodies: summarizeRequestBodies(input.waterfall)
    },
    dom: summarizeDom(events, startMono, endMono),
    realtime: summarizeRealtime(input.realtime),
    console: summarizeConsole(events),
    storage: summarizeStorage(events),
    perf: {
      vitals: countType(events, "perf.vitals"),
      longTasks: countType(events, "perf.longtask"),
      traces: countType(events, "perf.trace")
    }
  };
}

/** Plain-text lines for logs, bug reports and test failures. */
export function formatCaptureCompletenessReport(report: CaptureCompletenessReport): string[] {
  const { responseBodies, requestBodies } = report.network;
  const mimeLines = Object.entries(responseBodies.byMime)
    .sort(([, left], [, right]) => right.expected - left.expected)
    .map(
      ([mime, row]) =>
        `  ${mime}: ${row.captured}/${row.expected} captured, ${row.skipped} skipped, ` +
        `${row.missing} missing`
    );
  const missingLines = [...responseBodies.missingSamples, ...requestBodies.missingSamples].map(
    (sample) =>
      `  missing body: ${sample.method} ${sample.status ?? "-"} ${sample.mimeType ?? "-"} ` +
      sample.url
  );

  return [
    `Duration ${seconds(report.durationMs)} s; bodies requested: ${report.bodiesRequested ? "yes" : "no"}`,
    `Response bodies: ${formatBodies(responseBodies)}` +
      (responseBodies.dataUrls > 0 ? `; ${responseBodies.dataUrls} in data: URLs` : ""),
    ...mimeLines,
    `Request bodies: ${formatBodies(requestBodies)}`,
    `Requests: ${report.network.requests} (${report.network.internalRequests} extension/internal)`,
    `DOM: ${report.dom.snapshots} snapshots, ${report.dom.mutationBatches} mutation batches, ` +
      `${report.dom.rrwebEvents} rrweb events, coverage ${Math.round(report.dom.coverage * 100)}%, ` +
      `longest gap ${seconds(report.dom.longestGapMs)} s`,
    `Accessibility snapshots: ${report.dom.a11ySnapshots} (${report.dom.a11yTruncated} cut, ` +
      `${report.dom.a11yDroppedTriggers} triggers over the per-minute cap)`,
    `WebSocket: ${report.realtime.wsFrames} frames (${report.realtime.truncatedFrames} cut, ` +
      `${report.realtime.incompleteFrames} incomplete); SSE: ${report.realtime.sseMessages}`,
    `Console: ${report.console.entries} entries, ${report.console.errors} errors, ` +
      `${report.console.withStack} with stack, ${report.console.truncated} cut`,
    `Storage: cookies ${report.storage.cookieSnapshots} snapshots / ` +
      `${report.storage.cookieValues} values, localStorage ${report.storage.localSnapshots} / ` +
      `${report.storage.localValues}, IndexedDB ${report.storage.idbSnapshots} / ` +
      `${report.storage.idbRecords} records`,
    `Perf: ${report.perf.vitals} vitals, ${report.perf.longTasks} long tasks, ` +
      `${report.perf.traces} traces`,
    ...formatExport(report.export),
    ...formatCaptureFallback(report.captureFallback),
    ...missingLines
  ];
}

/** One line on a Full → Light fallback; none when the recording stayed in its engine. */
function formatCaptureFallback(fallback: CaptureFallbackInfo | null): string[] {
  return fallback
    ? [
        `Engine: ${fallback.from} → ${fallback.to} at ${isoTime(fallback.at)} (${fallback.reason}` +
          (fallback.detail && fallback.detail !== fallback.reason ? `: ${fallback.detail}` : "") +
          "); bodies, full console, screenshots and DevTools data are missing after that"
      ]
    : [];
}

/** Export lines: what the archive kept, what it left out and why, and an interruption. */
function formatExport(report: ExportCompleteness): string[] {
  const kept = report.recorded
    ? `Export: ${report.exportedEvents}/${report.storedEvents ?? 0} stored events` +
      (report.whole ? " (whole session)" : "")
    : `Export: ${report.exportedEvents} events (archive does not record what the export left out)`;
  const truncations = report.truncations.map(
    (row) =>
      `  left out (${row.reason}): ${row.events} events, ${row.chunks} chunks` +
      (row.fromT !== undefined && row.toT !== undefined
        ? `, ${isoTime(row.fromT)} – ${isoTime(row.toT)}`
        : "") +
      (row.limit !== undefined ? `, limit ${row.limit}` : "")
  );
  const interruption = report.interruption
    ? [
        `Interrupted: recording ended without Stop (${report.interruption.reason}), noticed ` +
          isoTime(report.interruption.detectedAt) +
          (report.interruption.lastSeenAt !== undefined
            ? `, last seen ${isoTime(report.interruption.lastSeenAt)}`
            : "")
      ]
    : [];

  return [kept, ...truncations, ...interruption];
}

function isoTime(ms: number): string {
  const date = new Date(ms);

  // Archive times are untrusted: a finite value outside the Date range must not throw.
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

/**
 * What the export kept, read from the manifest alone (cheap: no events are scanned).
 * `eventCount` stands in for the exported count when there is no manifest.
 */
export function readExportCompleteness(
  manifest: CompletenessInput["manifest"],
  eventCount = 0
): ExportCompleteness {
  const completeness = manifest?.completeness;
  const exportedEvents = manifest?.stats.eventCount ?? eventCount;

  if (!completeness) {
    return {
      recorded: false,
      whole: false,
      storedEvents: null,
      exportedEvents,
      truncations: [],
      interruption: null
    };
  }

  return {
    recorded: true,
    whole: completeness.truncations.length === 0,
    storedEvents: completeness.storedEvents,
    exportedEvents,
    truncations: completeness.truncations.map((row) => ({ ...row })),
    interruption: completeness.interruption ? { ...completeness.interruption } : null
  };
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function formatBodies(bodies: BodyCompleteness): string {
  const reasons = Object.entries(bodies.skipReasons)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");

  return (
    `${bodies.captured}/${bodies.expected} captured, ${bodies.skipped} skipped` +
    `${reasons ? ` (${reasons})` : ""}, ${bodies.missing} missing, ${bodies.truncated} cut`
  );
}

function emptyBodies(): BodyCompleteness {
  return {
    expected: 0,
    captured: 0,
    skipped: 0,
    missing: 0,
    truncated: 0,
    skipReasons: {},
    missingSamples: []
  };
}

function summarizeResponseBodies(
  waterfall: readonly CompletenessNetworkEntry[]
): ResponseBodyCompleteness {
  const summary = emptyBodies();
  const byMime: Record<string, MimeCompleteness> = {};
  let dataUrls = 0;

  for (const entry of waterfall) {
    if (!expectsResponseBody(entry)) {
      continue;
    }

    if (DATA_URL.test(entry.url)) {
      dataUrls += 1;
      continue;
    }

    const mime = normalizeMimeType(entry.mimeType) ?? "(none)";
    const row = byMime[mime] ?? { expected: 0, captured: 0, skipped: 0, missing: 0 };
    const outcome = tally(summary, entry, {
      captured: Boolean(entry.responseBodyHash),
      truncated: entry.responseBodyTruncated === true,
      skipReason: entry.responseBodySkip?.reason
    });

    byMime[mime] = { ...row, expected: row.expected + 1, [outcome]: row[outcome] + 1 };
  }

  return { ...summary, byMime, dataUrls };
}

function summarizeRequestBodies(waterfall: readonly CompletenessNetworkEntry[]): BodyCompleteness {
  const summary = emptyBodies();

  for (const entry of waterfall) {
    if (expectsRequestBody(entry)) {
      tally(summary, entry, {
        captured: entry.requestBodyText !== undefined,
        truncated: entry.requestBodyTruncated === true,
        skipReason: entry.requestBodySkipReason
      });
    }
  }

  return summary;
}

/** Adds one expected body to `summary` (a local accumulator) and returns its outcome. */
function tally(
  summary: BodyCompleteness,
  entry: CompletenessNetworkEntry,
  body: { captured: boolean; truncated: boolean; skipReason: BodySkipReason | undefined }
): "captured" | "skipped" | "missing" {
  summary.expected += 1;

  if (body.captured) {
    summary.captured += 1;
    summary.truncated += body.truncated ? 1 : 0;
    return "captured";
  }

  if (body.skipReason) {
    summary.skipped += 1;
    summary.skipReasons[body.skipReason] = (summary.skipReasons[body.skipReason] ?? 0) + 1;
    return "skipped";
  }

  summary.missing += 1;

  if (summary.missingSamples.length < MAX_MISSING_SAMPLES) {
    summary.missingSamples.push({
      reqId: entry.reqId,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      mimeType: entry.mimeType
    });
  }

  return "missing";
}

/** A finished textual response that has body bytes to keep. */
function expectsResponseBody(entry: CompletenessNetworkEntry): boolean {
  const status = entry.status;
  const mime = normalizeMimeType(entry.mimeType);

  return (
    !entry.failed &&
    !entry.pending &&
    !BROWSER_INTERNAL_URL.test(entry.url) &&
    entry.method.toUpperCase() !== "HEAD" &&
    status !== undefined &&
    ((status >= 200 && status < 300 && !BODYLESS_STATUSES.has(status)) || status === 304) &&
    mime !== undefined &&
    isTextualMimeType(mime)
  );
}

/** A request that sent a body that is text or has no content type (e.g. an untyped Blob). */
function expectsRequestBody(entry: CompletenessNetworkEntry): boolean {
  if (!entry.requestHasBody && entry.requestBodyText === undefined) {
    return false;
  }

  const contentType = normalizeMimeType(entry.requestHeaders["content-type"]);
  return !BROWSER_INTERNAL_URL.test(entry.url) && (!contentType || isTextualMimeType(contentType));
}

function summarizeDom(
  events: readonly WebBlackboxEvent[],
  startMono: number,
  endMono: number
): CaptureCompletenessReport["dom"] {
  const domEvents = events.filter((event) => DOM_CHANGE_EVENT_TYPES.has(event.type));
  const snapshotReasons: Record<string, number> = {};

  for (const event of domEvents) {
    if (event.type === "dom.snapshot") {
      const reason = readString(asObject(event.data)?.reason) ?? "(none)";
      snapshotReasons[reason] = (snapshotReasons[reason] ?? 0) + 1;
    }
  }

  const monos = domEvents.map((event) => event.mono);
  const durationMs = Math.max(0, endMono - startMono);
  const firstChange = monos[0];
  const lastChange = monos[monos.length - 1];
  const gaps = [
    (firstChange ?? endMono) - startMono,
    ...monos.slice(1).map((mono, index) => mono - monos[index]!),
    lastChange === undefined ? 0 : endMono - lastChange
  ];

  const a11y = events
    .filter((event) => event.type === "dom.a11y.snapshot")
    .map((event) => asObject(event.data));

  return {
    snapshots: countType(domEvents, "dom.snapshot"),
    mutationBatches: countType(domEvents, "dom.mutation.batch"),
    rrwebEvents: countType(domEvents, "dom.rrweb.event"),
    snapshotReasons,
    coverage:
      durationMs > 0 && firstChange !== undefined && lastChange !== undefined
        ? Math.min(1, (lastChange - firstChange) / durationMs)
        : 0,
    longestGapMs: Math.max(0, ...gaps),
    a11ySnapshots: a11y.length,
    a11yTruncated: a11y.filter((data) => data?.truncated === true).length,
    a11yDroppedTriggers: a11y.reduce(
      (sum, data) => sum + (typeof data?.droppedTriggers === "number" ? data.droppedTriggers : 0),
      0
    )
  };
}

function summarizeRealtime(
  realtime: readonly CompletenessRealtimeEntry[]
): CaptureCompletenessReport["realtime"] {
  const frames = realtime.filter((entry) => entry.eventType === "network.ws.frame");

  return {
    wsFrames: frames.length,
    sseMessages: realtime.filter((entry) => entry.eventType === "network.sse.message").length,
    truncatedFrames: frames.filter((entry) => entry.payloadTruncated).length,
    incompleteFrames: frames.filter(
      (entry) =>
        !entry.payloadTruncated &&
        !entry.payloadHash &&
        entry.payloadPreview !== undefined &&
        entry.payloadLength !== undefined &&
        entry.payloadPreview.length < entry.payloadLength
    ).length
  };
}

function summarizeConsole(
  events: readonly WebBlackboxEvent[]
): CaptureCompletenessReport["console"] {
  const entries = events.filter((event) => event.type === "console.entry");
  const errors = events.filter((event) => event.type.startsWith("error."));
  const all = [...entries, ...errors].map((event) => asObject(event.data));

  return {
    entries: entries.length,
    errors: errors.length,
    withStack: all.filter((data) => Boolean(data?.stack || data?.stackTrace)).length,
    truncated: all.filter((data) => data?.truncated === true).length
  };
}

function summarizeStorage(
  events: readonly WebBlackboxEvent[]
): CaptureCompletenessReport["storage"] {
  const snapshotsOf = (type: WebBlackboxEventType) =>
    events.filter((event) => event.type === type).map((event) => asObject(event.data));
  const cookies = snapshotsOf("storage.cookie.snapshot");
  const local = snapshotsOf("storage.local.snapshot");
  const idb = snapshotsOf("storage.idb.snapshot");

  return {
    cookieSnapshots: cookies.length,
    cookieValues: sum(cookies.map((data) => countWithValue(data?.cookies ?? data?.entries))),
    localSnapshots: local.length,
    localValues: sum(local.map((data) => countWithValue(data?.entries))),
    idbSnapshots: idb.length,
    idbRecords: sum(idb.map(countIdbRecords))
  };
}

function countWithValue(value: unknown): number {
  return asArray(value).filter((item) => typeof asObject(item)?.value === "string").length;
}

function countIdbRecords(data: Record<string, unknown> | null): number {
  return sum(
    asArray(data?.databases).flatMap((database) =>
      asArray(asObject(database)?.stores).map((store) => asArray(asObject(store)?.records).length)
    )
  );
}

function readNetworkPolicy(events: readonly WebBlackboxEvent[]): string | undefined {
  const config = events.find((event) => event.type === "meta.config");
  const categories = asObject(asObject(asObject(config?.data)?.capturePolicy)?.categories);
  return readString(categories?.network);
}

function countType(events: readonly WebBlackboxEvent[], type: WebBlackboxEventType): number {
  return events.filter((event) => event.type === type).length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
