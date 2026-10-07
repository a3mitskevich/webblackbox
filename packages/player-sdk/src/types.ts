import type {
  BodySkipReason,
  ChunkTimeIndexEntry,
  EventLevel,
  ExportManifest,
  HashesManifest,
  InvertedIndexEntry,
  PrivacyManifest,
  RequestIndexEntry,
  WebBlackboxEvent,
  WebBlackboxEventType
} from "@webblackbox/protocol";

import type { ArchiveLoadLimits } from "./archive-limits.js";

/** Player lifecycle status. */
export type PlayerStatus = "idle" | "loaded";

/** Supported input payloads when opening an archive. */
export type PlayerOpenInput = ArrayBuffer | Uint8Array | Blob;

/** Optional archive open settings. */
export type PlayerOpenOptions = {
  passphrase?: string;
  range?: PlayerRange;
  /** Resource limits for untrusted archives; unset fields use `DEFAULT_ARCHIVE_LOAD_LIMITS`. */
  limits?: Partial<ArchiveLoadLimits>;
};

/** Monotonic-time query range in milliseconds. */
export type PlayerRange = {
  monoStart?: number;
  monoEnd?: number;
};

/** Event query filter model. */
export type PlayerQuery = {
  range?: PlayerRange;
  types?: WebBlackboxEventType[];
  levels?: EventLevel[];
  text?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
};

/** Ranked full-text search hit for an event. */
export type PlayerSearchResult = {
  eventId: string;
  score: number;
  event: WebBlackboxEvent;
};

/** Aggregated user action span. */
export type ActionSpan = {
  actId: string;
  startMono: number;
  endMono: number;
  eventIds: string[];
  triggerEventId: string;
  requestCount: number;
  errorCount: number;
};

/** Action timeline row with network/error/screenshot context. */
export type ActionTimelineEntry = {
  actId: string;
  triggerEventId: string;
  triggerType: string | null;
  startMono: number;
  endMono: number;
  durationMs: number;
  eventCount: number;
  requestCount: number;
  errorCount: number;
  requests: Array<{
    reqId: string;
    method: string;
    url: string;
    status: number | null;
    failed: boolean;
    durationMs: number;
  }>;
  errors: Array<{
    eventId: string;
    type: string;
    mono: number;
    message: string | null;
  }>;
  screenshot: {
    eventId: string;
    mono: number;
    shotId: string | null;
    reason: string | null;
    format: string | null;
    size: number | null;
  } | null;
};

/** Replay confidence row that links action, request/response, error, and screenshot evidence. */
export type ReplayDiagnosticEntry = {
  actId: string;
  confidence: "high" | "medium" | "low";
  triggerEventId: string;
  triggerType: string | null;
  causeChain: string[];
  requestResponseDiffs: Array<{
    reqId: string;
    method: string;
    url: string;
    capturedStatus: number | null;
    failed: boolean;
    hasRequestBody: boolean;
    hasResponseBody: boolean;
    responseBodySize: number | null;
  }>;
  errorMessages: string[];
  screenshotEventId: string | null;
};

/** Concrete request/response comparison for replay confidence and debugging. */
export type RequestResponseDiff = {
  reqId: string;
  method: string;
  url: string;
  status: number | null;
  requestBodyBytes: number;
  responseBodyBytes: number;
  bodySizeDeltaBytes: number;
  requestHeaderNames: string[];
  responseHeaderNames: string[];
  missingReplayInputs: string[];
};

/** Cached derived analysis view. */
export type PlayerDerivedView = {
  actionSpans: ActionSpan[];
  totals: {
    events: number;
    errors: number;
    requests: number;
  };
};

/** Parsed archive metadata and indexes. */
export type PlayerArchive = {
  manifest: ExportManifest;
  timeIndex: ChunkTimeIndexEntry[];
  requestIndex: RequestIndexEntry[];
  invertedIndex: InvertedIndexEntry[];
  integrity: HashesManifest;
  privacyManifest: PrivacyManifest | null;
};

/** Explainable privacy posture for export/share preflight review. */
export type PrivacyProtectionReport = {
  encrypted: boolean;
  redaction: {
    hashSensitiveValues: boolean;
    headers: string[];
    cookieNames: string[];
    bodyPatterns: string[];
    blockedSelectors: string[];
    strategy: string[];
  };
  detected: {
    redactedMarkers: number;
    hashedSensitiveValues: number;
    sensitiveKeyMentions: number;
  };
  scanner: {
    preEncryption: boolean;
    status: "passed" | "blocked" | "unknown";
    findingCount: number;
  };
};

/** Bounded sensitive-data preview for export/share review before publishing an archive. */
export type SensitiveDataPreview = {
  totalMatches: number;
  samples: Array<{
    eventId: string;
    type: WebBlackboxEventType;
    mono: number;
    reason: "redacted-marker" | "hashed-value" | "sensitive-pattern";
    snippet: string;
  }>;
};

/** Normalized request waterfall entry. */
export type NetworkWaterfallEntry = {
  reqId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  startMono: number;
  endMono: number;
  durationMs: number;
  startWallTime: number;
  endWallTime: number;
  failed: boolean;
  errorText?: string;
  actionId?: string;
  encodedDataLength?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyText?: string;
  /** The request carried a body (CDP `hasPostData`, or a known body size above zero). */
  requestHasBody?: true;
  /** The request body was cut at the profile limit. */
  requestBodyTruncated?: true;
  /** Why the request body the policy asked for is not in the archive. */
  requestBodySkipReason?: BodySkipReason;
  responseBodyHash?: string;
  responseBodySize?: number;
  /** The stored response body is a prefix cut at the profile limit. */
  responseBodyTruncated?: true;
  /** Why the response body the policy asked for is not in the archive. */
  responseBodySkip?: NetworkBodySkip;
  /** Where the response came from when it skipped the network (CDP cache / service-worker flags). */
  fromCache?: NetworkCacheSource;
  /** Set when the archive holds no response, finish or failure: still open when recording stopped. */
  pending?: true;
  eventIds: string[];
};

/** A response body the policy asked for and the recorder could not keep, with the reason. */
export type NetworkBodySkip = {
  reason: BodySkipReason;
  size?: number;
  limit?: number;
  detail?: string;
};

/** Cache layer that served a request, from CDP `requestServedFromCache` and response flags. */
export type NetworkCacheSource = "memory" | "disk" | "prefetch" | "service-worker";

/** Realtime network stream entry (WebSocket/SSE). */
export type RealtimeNetworkEntry = {
  eventId: string;
  eventType: WebBlackboxEventType;
  protocol: "ws" | "sse";
  mono: number;
  t: number;
  streamId?: string;
  direction?: "sent" | "received" | "unknown";
  phase?: string;
  url?: string;
  opcode?: number;
  payloadLength?: number;
  payloadPreview?: string;
  /** Blob hash of the full payload when it was too large to keep inline (see `getRealtimePayloadText`). */
  payloadHash?: string;
  /** The recorder hit the profile body limit; the stored payload is a prefix. */
  payloadTruncated?: boolean;
  snapshot?: unknown;
};

/** Storage event timeline entry. */
export type StorageTimelineEntry = {
  eventId: string;
  eventType: WebBlackboxEventType;
  t: number;
  mono: number;
  kind: "cookie" | "local" | "session" | "idb" | "cache" | "sw" | "unknown";
  operation?: string;
  hash?: string;
  mode?: string;
  count?: number;
  reason?: string;
  snapshot?: unknown;
};

/** Performance artifact timeline entry. */
export type PerformanceArtifactEntry = {
  eventId: string;
  eventType: WebBlackboxEventType;
  t: number;
  mono: number;
  kind: "trace" | "cpu" | "heap" | "longtask" | "vitals" | "other";
  hash?: string;
  size?: number;
  reason?: string;
  snapshot?: unknown;
};

/** Session-vs-session comparison summary. */
export type PlayerComparison = {
  leftSessionId: string;
  rightSessionId: string;
  /** @deprecated Use leftSessionId instead. */
  leftSid: string;
  /** @deprecated Use rightSessionId instead. */
  rightSid: string;
  eventDelta: number;
  errorDelta: number;
  requestDelta: number;
  durationDeltaMs: number;
  typeDeltas: Array<{
    type: string;
    left: number;
    right: number;
    delta: number;
  }>;
  endpointRegressions: Array<{
    endpoint: string;
    method: string;
    leftCount: number;
    rightCount: number;
    countDelta: number;
    leftFailed: number;
    rightFailed: number;
    failedDelta: number;
    leftFailureRate: number;
    rightFailureRate: number;
    failureRateDelta: number;
    leftP95DurationMs: number;
    rightP95DurationMs: number;
    p95DurationDeltaMs: number;
  }>;
};

/** Storage-only comparison summary. */
export type StorageComparison = {
  leftEvents: number;
  rightEvents: number;
  kindDeltas: Array<{
    kind: StorageTimelineEntry["kind"];
    left: number;
    right: number;
    delta: number;
  }>;
  hashOnlyLeft: string[];
  hashOnlyRight: string[];
};

/** Bug report generation options. */
export type BugReportOptions = {
  title?: string;
  range?: PlayerRange;
  maxItems?: number;
};

/** Playwright script generation options. */
export type PlaywrightScriptOptions = {
  name?: string;
  range?: PlayerRange;
  startUrl?: string;
  maxActions?: number;
  includeHarReplay?: boolean;
};

/** Playwright mock script generation options. */
export type PlaywrightMockScriptOptions = PlaywrightScriptOptions & {
  maxMocks?: number;
};

/** Shared options for team issue template generation. */
export type TeamIssueTemplateOptions = {
  title?: string;
  range?: PlayerRange;
  maxItems?: number;
  labels?: string[];
  assignees?: string[];
  issueType?: string;
  projectKey?: string;
  priority?: string;
};

/** GitHub issue payload generated from a session. */
export type GitHubIssueTemplate = {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
};

/** Jira issue payload generated from a session. */
export type JiraIssueTemplate = {
  fields: {
    summary: string;
    description: string;
    issuetype: {
      name: string;
    };
    labels: string[];
    project?: {
      key: string;
    };
    priority?: {
      name: string;
    };
  };
};

/** DOM snapshot reference entry from the timeline. */
export type DomSnapshotRef = {
  eventId: string;
  mono: number;
  t: number;
  snapshotId?: string;
  contentHash?: string;
  source?: string;
  nodeCount?: number;
  reason?: string;
};

/** DOM diff timeline query options. */
export type DomDiffTimelineOptions = {
  range?: PlayerRange;
  limit?: number;
};

/** Result of diffing two DOM snapshots. */
export type DomDiffResult = {
  previous: DomSnapshotRef;
  current: DomSnapshotRef;
  addedPaths: string[];
  removedPaths: string[];
  changedPaths: string[];
  summary: {
    added: number;
    removed: number;
    changed: number;
  };
};
