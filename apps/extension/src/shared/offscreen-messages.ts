import type {
  CapturePolicy,
  HashesManifest,
  PrivacyScannerFinding,
  PrivacyScannerFindingKind,
  PrivacyScannerResult,
  RedactionProfile,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { parseStorageKeyMessage, type StorageKeyMessage } from "./at-rest.js";

/**
 * The service worker <-> offscreen document contract. Both sides import these types, and each
 * side checks what it receives with the guards below: extension ports carry JSON, so a message
 * is plain data until a guard has looked at it. Binary payloads never travel as typed arrays
 * (JSON turns them into `{"0":137,…}` number maps): blobs go as base64 and tab video stays in
 * the offscreen document, which only reports chunk metadata.
 */
export const OFFSCREEN_CONNECT_REQUEST_KIND = "sw.offscreen-connect";
export const PIPELINE_REQUEST_KIND = "sw.pipeline-request";
export const PIPELINE_RESPONSE_KIND = "offscreen.pipeline-response";
/** Prefix of the error for a session whose pipeline this offscreen document does not hold. */
export const PIPELINE_SESSION_NOT_FOUND_ERROR = "Pipeline session not found";

export type ScreenRecordingSource = "tab";

export type PipelineExportOptions = {
  passphrase?: string;
  includeScreenshots?: boolean;
  includeScreenRecordings?: boolean;
  maxArchiveBytes?: number;
  recentWindowMs?: number;
};

type RequestOf<TOp extends string, TFields = object> = { op: TOp; sid: string } & TFields;

export type OffscreenPipelineRequest =
  | RequestOf<
      "start",
      {
        session: SessionMetadata;
        redactionProfile?: RedactionProfile;
        capturePolicy?: CapturePolicy;
      }
    >
  | RequestOf<"ingest", { event: WebBlackboxEvent }>
  | RequestOf<"ingestBatch", { events: WebBlackboxEvent[] }>
  | RequestOf<"flush">
  /** `base64`: the blob's bytes, see the module comment. */
  | RequestOf<"putBlob", { mime: string; base64: string }>
  | RequestOf<"exportDownload", PipelineExportOptions>
  | RequestOf<"close", { purge?: boolean }>
  | RequestOf<
      "startScreenRecording",
      { recordingId: string; streamId: string; source: ScreenRecordingSource }
    >
  | RequestOf<"stopScreenRecording", { recordingId?: string; reason?: string }>;

export type OffscreenPipelineOp = OffscreenPipelineRequest["op"];
export type OffscreenPipelineRequestFor<TOp extends OffscreenPipelineOp> = Extract<
  OffscreenPipelineRequest,
  { op: TOp }
>;
export type OffscreenPipelineRequestMessage = OffscreenPipelineRequest & {
  kind: typeof PIPELINE_REQUEST_KIND;
  requestId: string;
};

export type PipelineExportDownloadResult = {
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  downloadId?: number;
  integrity: HashesManifest;
  privacyScanner?: PrivacyScannerResult;
};

export type ScreenRecordingStartResult = {
  recordingId: string;
  source: ScreenRecordingSource;
  mime: string;
  width?: number;
  height?: number;
  frameRate?: number;
  audio: boolean;
};

export type ScreenRecordingStopResult = {
  recordingId: string;
  mime: string;
  /** Chunks stored in the pipeline. */
  chunkCount: number;
  size: number;
  durationMs: number;
  width?: number;
  height?: number;
  reason?: string;
};

/** What each op resolves to on the service worker side. */
export type OffscreenPipelineResults = {
  start: null;
  ingest: null;
  /** Stored NDJSON bytes of the batch. */
  ingestBatch: number;
  /** Content hash of the stored blob. */
  putBlob: string;
  flush: null;
  exportDownload: PipelineExportDownloadResult;
  close: null;
  startScreenRecording: ScreenRecordingStartResult;
  stopScreenRecording: ScreenRecordingStopResult;
};

export type OffscreenPipelineResponseMessage =
  | { kind: typeof PIPELINE_RESPONSE_KIND; requestId: string; ok: true; result?: unknown }
  | { kind: typeof PIPELINE_RESPONSE_KIND; requestId: string; ok: false; error: string };

export type OffscreenReadyMessage = { kind: "offscreen.ready"; t: number };

export type OffscreenKeepaliveMessage = {
  kind: "offscreen.keepalive";
  activeSessions: number;
  t: number;
};

/** A tab video chunk the offscreen document has stored in the session's pipeline. */
export type ScreenRecordingChunkMessage = {
  kind: "offscreen.screen-recording-chunk";
  sid: string;
  recordingId: string;
  index: number;
  mime: string;
  /** Content hash of the stored chunk blob. */
  chunkId: string;
  size: number;
  startOffsetMs: number;
  endOffsetMs: number;
  durationMs: number;
};

export type ScreenRecordingEndedMessage = {
  kind: "offscreen.screen-recording-ended";
  sid: string;
  result: ScreenRecordingStopResult;
};

export type ScreenRecordingErrorMessage = {
  kind: "offscreen.screen-recording-error";
  sid: string;
  recordingId?: string;
  name?: string;
  message: string;
  stage?: string;
};

export type OffscreenToSwMessage =
  | OffscreenPipelineResponseMessage
  | OffscreenReadyMessage
  | OffscreenKeepaliveMessage
  | ScreenRecordingChunkMessage
  | ScreenRecordingEndedMessage
  | ScreenRecordingErrorMessage;

/** The part of the recording status broadcast the offscreen document reads. */
export type SwRecordingStatusMessage = { kind: "sw.recording-status"; active: boolean };

export type OffscreenSessionSummary = {
  sid: string;
  tabId: number;
  mode: SessionMetadata["mode"];
  startedAt: number;
  active: boolean;
  eventCount: number;
  errorCount: number;
  budgetAlertCount: number;
  sizeBytes: number;
  tags: string[];
  note?: string;
};

export type SwPipelineStatusMessage = {
  kind: "sw.pipeline-status";
  activeSessions: number;
  sessions: OffscreenSessionSummary[];
  updatedAt: number;
};

export type SwToOffscreenMessage =
  | SwRecordingStatusMessage
  | SwPipelineStatusMessage
  | StorageKeyMessage
  | OffscreenPipelineRequestMessage;

export type ParsedPipelineRequest =
  | { ok: true; request: OffscreenPipelineRequestMessage }
  /** `requestId` is null when the request cannot even be answered. */
  | { ok: false; requestId: string | null; error: string };

const PIPELINE_OPS: ReadonlySet<string> = new Set<OffscreenPipelineOp>([
  "start",
  "ingest",
  "ingestBatch",
  "flush",
  "putBlob",
  "exportDownload",
  "close",
  "startScreenRecording",
  "stopScreenRecording"
]);

const PRIVACY_SCANNER_FINDING_KINDS: ReadonlySet<string> = new Set<PrivacyScannerFindingKind>([
  "jwt",
  "bearer-token",
  "api-key",
  "oauth-code",
  "session-cookie",
  "email",
  "phone",
  "credit-card",
  "ssn",
  "private-key",
  "long-secret"
]);

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/** Offscreen side: everything the service worker may send over the pipeline port. */
export function parseSwToOffscreenMessage(raw: unknown): SwToOffscreenMessage | null {
  const row = asRecord(raw);

  switch (row?.kind) {
    case "sw.recording-status":
      return { kind: "sw.recording-status", active: row.active === true };
    case "sw.pipeline-status":
      return {
        kind: "sw.pipeline-status",
        activeSessions: Math.max(0, asFiniteNumber(row.activeSessions) ?? 0),
        sessions: Array.isArray(row.sessions) ? (row.sessions as OffscreenSessionSummary[]) : [],
        updatedAt: asFiniteNumber(row.updatedAt) ?? Date.now()
      };
    case PIPELINE_REQUEST_KIND: {
      const parsed = parsePipelineRequest(row);
      return parsed.ok ? parsed.request : null;
    }
    default:
      return parseStorageKeyMessage(raw);
  }
}

/**
 * Offscreen side: checks a pipeline request and its op's fields. A request with an id but bad
 * fields comes back as an error to answer, so the worker is not left waiting for a timeout.
 */
export function parsePipelineRequest(raw: unknown): ParsedPipelineRequest {
  const row = asRecord(raw);

  if (row?.kind !== PIPELINE_REQUEST_KIND) {
    return { ok: false, requestId: null, error: "Not a pipeline request." };
  }

  const requestId = asNonEmptyString(row.requestId);

  if (!requestId) {
    return { ok: false, requestId: null, error: "Pipeline request without a request id." };
  }

  const reject = (error: string): ParsedPipelineRequest => ({ ok: false, requestId, error });
  const op = row.op;
  const sid = asNonEmptyString(row.sid);

  if (typeof op !== "string" || !PIPELINE_OPS.has(op)) {
    return reject(`Unsupported pipeline operation: ${String(op)}`);
  }

  if (!sid) {
    return reject(`Missing session id for pipeline ${op}.`);
  }

  const fields = parsePipelineRequestFields(op as OffscreenPipelineOp, sid, row);

  if (typeof fields === "string") {
    return reject(fields);
  }

  return { ok: true, request: { kind: PIPELINE_REQUEST_KIND, requestId, ...fields } };
}

/** The op-specific part of a request, or the reason it is invalid. */
function parsePipelineRequestFields(
  op: OffscreenPipelineOp,
  sid: string,
  row: Record<string, unknown>
): OffscreenPipelineRequest | string {
  switch (op) {
    case "start":
      if (!isSessionMetadata(row.session)) {
        return "Missing session metadata for pipeline start.";
      }

      return {
        op,
        sid,
        session: row.session,
        redactionProfile: asOptionalRecord<RedactionProfile>(row.redactionProfile),
        capturePolicy: asOptionalRecord<CapturePolicy>(row.capturePolicy)
      };
    case "ingest":
      return isEventLike(row.event)
        ? { op, sid, event: row.event }
        : "Missing event payload for pipeline ingest.";
    case "ingestBatch":
      return Array.isArray(row.events) && row.events.every(isEventLike)
        ? { op, sid, events: row.events }
        : "Invalid event batch for pipeline ingestBatch.";
    case "flush":
      return { op, sid };
    case "putBlob": {
      const mime = asNonEmptyString(row.mime);

      if (!mime) {
        return "Missing mime for blob write.";
      }

      return typeof row.base64 === "string" && row.base64.length > 0
        ? { op, sid, mime, base64: row.base64 }
        : "Missing blob bytes.";
    }
    case "exportDownload":
      return {
        op,
        sid,
        passphrase: asOptionalString(row.passphrase),
        includeScreenshots: asOptionalBoolean(row.includeScreenshots),
        includeScreenRecordings: asOptionalBoolean(row.includeScreenRecordings),
        maxArchiveBytes: asFiniteNumber(row.maxArchiveBytes) ?? undefined,
        recentWindowMs: asFiniteNumber(row.recentWindowMs) ?? undefined
      };
    case "close":
      return { op, sid, purge: row.purge === true };
    case "startScreenRecording": {
      const recordingId = asNonEmptyString(row.recordingId);
      const streamId = asNonEmptyString(row.streamId);

      if (!recordingId) {
        return "Missing recording id.";
      }

      return streamId
        ? { op, sid, recordingId, streamId, source: "tab" }
        : "Missing tab capture stream id.";
    }
    case "stopScreenRecording":
      return {
        op,
        sid,
        recordingId: asNonEmptyString(row.recordingId) ?? undefined,
        reason: asNonEmptyString(row.reason) ?? undefined
      };
  }
}

/** Service worker side: everything the offscreen document may send over the pipeline port. */
export function parseOffscreenToSwMessage(raw: unknown): OffscreenToSwMessage | null {
  const row = asRecord(raw);

  switch (row?.kind) {
    case PIPELINE_RESPONSE_KIND:
      return parsePipelineResponse(row);
    case "offscreen.ready":
      return { kind: "offscreen.ready", t: asFiniteNumber(row.t) ?? Date.now() };
    case "offscreen.keepalive":
      return {
        kind: "offscreen.keepalive",
        activeSessions: Math.max(0, asFiniteNumber(row.activeSessions) ?? 0),
        t: asFiniteNumber(row.t) ?? Date.now()
      };
    case "offscreen.screen-recording-chunk":
      return parseScreenRecordingChunk(row);
    case "offscreen.screen-recording-ended": {
      const sid = asNonEmptyString(row.sid);
      const result = parseScreenRecordingStopResult(row.result);
      return sid && result ? { kind: "offscreen.screen-recording-ended", sid, result } : null;
    }
    case "offscreen.screen-recording-error": {
      const sid = asNonEmptyString(row.sid);
      return sid
        ? {
            kind: "offscreen.screen-recording-error",
            sid,
            recordingId: asNonEmptyString(row.recordingId) ?? undefined,
            name: asOptionalString(row.name),
            message: typeof row.message === "string" ? row.message : "Screen recording failed.",
            stage: asOptionalString(row.stage)
          }
        : null;
    }
    default:
      return null;
  }
}

function parsePipelineResponse(
  row: Record<string, unknown>
): OffscreenPipelineResponseMessage | null {
  const requestId = asNonEmptyString(row.requestId);

  if (!requestId) {
    return null;
  }

  if (row.ok === true) {
    return { kind: PIPELINE_RESPONSE_KIND, requestId, ok: true, result: row.result };
  }

  return {
    kind: PIPELINE_RESPONSE_KIND,
    requestId,
    ok: false,
    error: asNonEmptyString(row.error) ?? "Offscreen pipeline request failed."
  };
}

function parseScreenRecordingChunk(
  row: Record<string, unknown>
): ScreenRecordingChunkMessage | null {
  const sid = asNonEmptyString(row.sid);
  const recordingId = asNonEmptyString(row.recordingId);
  const chunkId = asNonEmptyString(row.chunkId);
  const index = asFiniteNumber(row.index);
  const size = asFiniteNumber(row.size);

  if (!sid || !recordingId || !chunkId || index === null || index < 0 || !size || size <= 0) {
    return null;
  }

  return {
    kind: "offscreen.screen-recording-chunk",
    sid,
    recordingId,
    index: Math.floor(index),
    mime: asNonEmptyString(row.mime) ?? "video/webm",
    chunkId,
    size,
    startOffsetMs: asOffsetMs(row.startOffsetMs),
    endOffsetMs: asOffsetMs(row.endOffsetMs),
    durationMs: asOffsetMs(row.durationMs)
  };
}

/** Service worker side: checks what an op resolved to; throws when it is not usable. */
export function parsePipelineResult<TOp extends OffscreenPipelineOp>(
  op: TOp,
  raw: unknown
): OffscreenPipelineResults[TOp] {
  return parsePipelineResultUnchecked(op, raw) as OffscreenPipelineResults[TOp];
}

function parsePipelineResultUnchecked(
  op: OffscreenPipelineOp,
  raw: unknown
): OffscreenPipelineResults[OffscreenPipelineOp] {
  switch (op) {
    case "ingestBatch": {
      const bytes = asFiniteNumber(raw);
      return bytes !== null && bytes > 0 ? bytes : 0;
    }
    case "putBlob": {
      const hash = asNonEmptyString(raw);

      if (!hash) {
        throw new Error("Offscreen blob write did not return a content hash.");
      }

      return hash;
    }
    case "exportDownload":
      return parseExportDownloadResult(raw);
    case "startScreenRecording": {
      const result = parseScreenRecordingStartResult(raw);

      if (!result) {
        throw new Error("Invalid offscreen screen recording start result.");
      }

      return result;
    }
    case "stopScreenRecording": {
      const result = parseScreenRecordingStopResult(raw);

      if (!result) {
        throw new Error("Invalid offscreen screen recording stop result.");
      }

      return result;
    }
    case "start":
    case "ingest":
    case "flush":
    case "close":
      return null;
  }
}

export function parseExportDownloadResult(raw: unknown): PipelineExportDownloadResult {
  const row = asRecord(raw);

  if (!row) {
    throw new Error("Invalid offscreen export payload.");
  }

  const fileName = asNonEmptyString(row.fileName) ?? "session.webblackbox";
  const sizeBytes = asFiniteNumber(row.sizeBytes);
  const downloadUrl = asNonEmptyString(row.downloadUrl);

  if (sizeBytes === null || sizeBytes <= 0) {
    throw new Error("Offscreen export payload did not include valid archive size.");
  }

  if (!downloadUrl) {
    throw new Error("Offscreen export payload did not include download URL.");
  }

  return {
    fileName,
    sizeBytes: Math.round(sizeBytes),
    downloadUrl,
    downloadId: asFiniteNumber(row.downloadId) ?? undefined,
    integrity: parseHashesManifest(row.integrity),
    privacyScanner: parsePrivacyScannerResult(row.privacyScanner)
  };
}

function parsePrivacyScannerResult(raw: unknown): PrivacyScannerResult | undefined {
  const row = asRecord(raw);
  const status = row?.status === "blocked" || row?.status === "passed" ? row.status : null;

  if (!row || !status) {
    return undefined;
  }

  return {
    scannedAt: typeof row.scannedAt === "string" ? row.scannedAt : new Date().toISOString(),
    preEncryption: row.preEncryption === true,
    status,
    findings: Array.isArray(row.findings)
      ? row.findings
          .map(parsePrivacyScannerFinding)
          .filter((finding): finding is PrivacyScannerFinding => finding !== null)
      : []
  };
}

function parsePrivacyScannerFinding(raw: unknown): PrivacyScannerFinding | null {
  const row = asRecord(raw);
  const kind = row?.kind;
  const path = asNonEmptyString(row?.path);
  const matchCount = asFiniteNumber(row?.matchCount);

  if (
    typeof kind !== "string" ||
    !PRIVACY_SCANNER_FINDING_KINDS.has(kind) ||
    !path ||
    matchCount === null ||
    matchCount <= 0
  ) {
    return null;
  }

  const sampleSha256 = row?.sampleSha256;

  return {
    kind: kind as PrivacyScannerFindingKind,
    severity: "high",
    path,
    matchCount: Math.round(matchCount),
    sampleSha256:
      typeof sampleSha256 === "string" && SHA256_HEX_PATTERN.test(sampleSha256)
        ? sampleSha256
        : "0".repeat(64)
  };
}

function parseHashesManifest(value: unknown): HashesManifest {
  const row = asRecord(value);
  const filesRow = asRecord(row?.files);
  const files = Object.fromEntries(
    Object.entries(filesRow ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

  return {
    manifestSha256: typeof row?.manifestSha256 === "string" ? row.manifestSha256 : "",
    files
  };
}

function parseScreenRecordingStartResult(raw: unknown): ScreenRecordingStartResult | null {
  const row = asRecord(raw);
  const recordingId = asNonEmptyString(row?.recordingId);
  const mime = asNonEmptyString(row?.mime);

  if (!row || !recordingId || !mime) {
    return null;
  }

  return {
    recordingId,
    source: "tab",
    mime,
    width: asPositiveNumber(row.width),
    height: asPositiveNumber(row.height),
    frameRate: asPositiveNumber(row.frameRate),
    audio: row.audio === true
  };
}

function parseScreenRecordingStopResult(raw: unknown): ScreenRecordingStopResult | null {
  const row = asRecord(raw);
  const recordingId = asNonEmptyString(row?.recordingId);

  if (!row || !recordingId) {
    return null;
  }

  return {
    recordingId,
    mime: asNonEmptyString(row.mime) ?? "video/webm",
    chunkCount: Math.max(0, asFiniteNumber(row.chunkCount) ?? 0),
    size: Math.max(0, asFiniteNumber(row.size) ?? 0),
    durationMs: asOffsetMs(row.durationMs),
    width: asPositiveNumber(row.width),
    height: asPositiveNumber(row.height),
    reason: asOptionalString(row.reason)
  };
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  const row = asRecord(value);
  return (
    row !== null &&
    asNonEmptyString(row.sid) !== null &&
    asFiniteNumber(row.tabId) !== null &&
    asFiniteNumber(row.startedAt) !== null &&
    typeof row.mode === "string"
  );
}

function isEventLike(value: unknown): value is WebBlackboxEvent {
  const row = asRecord(value);
  return row !== null && typeof row.type === "string" && typeof row.id === "string";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asOptionalRecord<T>(value: unknown): T | undefined {
  return asRecord(value) ? (value as T) : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPositiveNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== null && number > 0 ? number : undefined;
}

/** Recording offsets and durations: whole, non-negative milliseconds. */
function asOffsetMs(value: unknown): number {
  return Math.max(0, Math.round(asFiniteNumber(value) ?? 0));
}
