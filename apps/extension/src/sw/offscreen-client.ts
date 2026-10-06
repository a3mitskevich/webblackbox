import type {
  CapturePolicy,
  RedactionProfile,
  SessionMetadata,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { base64DecodedLength, bytesToBase64 } from "../shared/base64.js";
import type { PortLike } from "../shared/chrome-api.js";
import {
  parseOffscreenToSwMessage,
  parsePipelineResult,
  PIPELINE_REQUEST_KIND,
  PIPELINE_SESSION_NOT_FOUND_ERROR,
  type OffscreenPipelineOp,
  type OffscreenPipelineRequestFor,
  type OffscreenPipelineRequestMessage,
  type OffscreenPipelineResponseMessage,
  type OffscreenPipelineResults,
  type OffscreenToSwMessage,
  type PipelineExportDownloadResult,
  type PipelineExportOptions,
  type SwToOffscreenMessage
} from "../shared/offscreen-messages.js";
import { OFFSCREEN_UNAVAILABLE_ERROR } from "./offscreen-port.js";
import type { PortTrafficMeter } from "./port-traffic.js";

export const OFFSCREEN_DISCONNECTED_ERROR = "Offscreen pipeline disconnected.";
const OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;
const OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS = 12 * 60_000;
/** Slower requests are logged while perf logging is on. */
const OFFSCREEN_REQUEST_PERF_WARN_MS = 40;

/** One recording session's view of the offscreen pipeline. */
export type SessionPipelineClient = {
  start: (
    session: SessionMetadata,
    redactionProfile: RedactionProfile,
    capturePolicy?: CapturePolicy
  ) => Promise<void>;
  ingest: (event: WebBlackboxEvent) => Promise<void>;
  /** Resolves to the stored NDJSON bytes of the batch. */
  ingestBatch: (events: WebBlackboxEvent[]) => Promise<number>;
  flush: () => Promise<void>;
  putBlob: (mime: string, bytes: Uint8Array) => Promise<string>;
  exportAndDownload: (options?: PipelineExportOptions) => Promise<PipelineExportDownloadResult>;
  close: (options?: { purge?: boolean }) => Promise<void>;
};

/** Offscreen messages other than request responses, for the worker to act on. */
export type OffscreenEventMessage = Exclude<OffscreenToSwMessage, OffscreenPipelineResponseMessage>;

export type OffscreenClientDeps = {
  /** The connected offscreen port, creating or reviving the document when needed. */
  ensurePort(): Promise<PortLike>;
  /** Starts the session's pipeline again in an offscreen document that lost it. */
  recoverSession(sid: string): Promise<void>;
  traffic: PortTrafficMeter;
  shouldLogPerf(): boolean;
  now?(): number;
  timeoutMs?: { default: number; exportDownload: number };
};

export type OffscreenClient = {
  /** Sends a request; when the pipeline went away it recovers the session and retries once. */
  request<TOp extends OffscreenPipelineOp>(
    request: OffscreenPipelineRequestFor<TOp>
  ): Promise<OffscreenPipelineResults[TOp]>;
  /** A single attempt, for the recovery itself. */
  requestOnce<TOp extends OffscreenPipelineOp>(
    request: OffscreenPipelineRequestFor<TOp>
  ): Promise<OffscreenPipelineResults[TOp]>;
  /** Posts a notification on `port`; throws when the port is gone. */
  post(port: PortLike, message: SwToOffscreenMessage): void;
  /**
   * Takes a raw message from the offscreen port: settles the request it answers, or returns the
   * checked event. Returns null for responses and for anything malformed.
   */
  receive(raw: unknown): OffscreenEventMessage | null;
  /** Fails every request still waiting, e.g. when the port disconnects. */
  rejectPending(reason: string): void;
  pendingCount(): number;
};

type PendingRequest = {
  op: OffscreenPipelineOp;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function createOffscreenClient(deps: OffscreenClientDeps): OffscreenClient {
  const pending = new Map<string, PendingRequest>();
  const now = deps.now ?? (() => performance.now());
  const timeouts = deps.timeoutMs ?? {
    default: OFFSCREEN_REQUEST_TIMEOUT_DEFAULT_MS,
    exportDownload: OFFSCREEN_REQUEST_TIMEOUT_EXPORT_MS
  };
  let requestSeq = 0;

  const requestOnce = async <TOp extends OffscreenPipelineOp>(
    request: OffscreenPipelineRequestFor<TOp>
  ): Promise<OffscreenPipelineResults[TOp]> => {
    const port = await deps.ensurePort();
    const requestId = `off-${Date.now()}-${requestSeq}`;
    const timeoutMs = request.op === "exportDownload" ? timeouts.exportDownload : timeouts.default;
    requestSeq += 1;

    const raw = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timed out waiting for offscreen response: ${request.op}`));
      }, timeoutMs);

      pending.set(requestId, { op: request.op, resolve, reject, timeout });

      try {
        const message: OffscreenPipelineRequestMessage = {
          ...request,
          kind: PIPELINE_REQUEST_KIND,
          requestId
        };
        deps.traffic.recordSent(request.op, message, measureBinaryBytes(message));
        port.postMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return parsePipelineResult(request.op as TOp, raw);
  };

  const requestWithRecovery = async <TOp extends OffscreenPipelineOp>(
    request: OffscreenPipelineRequestFor<TOp>
  ): Promise<OffscreenPipelineResults[TOp]> => {
    try {
      return await requestOnce(request);
    } catch (error) {
      if (request.op === "start" || !isPipelineLostError(error)) {
        throw error;
      }

      await deps.recoverSession(request.sid);
      return await requestOnce(request);
    }
  };

  const settle = (response: OffscreenPipelineResponseMessage): void => {
    const entry = pending.get(response.requestId);

    if (!entry) {
      return;
    }

    clearTimeout(entry.timeout);
    pending.delete(response.requestId);

    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response.error));
    }
  };

  return {
    request: async (request) => {
      const startedAt = now();
      const result = await requestWithRecovery(request);
      const durationMs = now() - startedAt;

      if (durationMs >= OFFSCREEN_REQUEST_PERF_WARN_MS && deps.shouldLogPerf()) {
        console.info("[WebBlackbox][perf] offscreen request", {
          op: request.op,
          durationMs: Number(durationMs.toFixed(2)),
          queuePending: pending.size
        });
      }

      return result;
    },
    requestOnce,
    post: (port, message) => {
      deps.traffic.recordSent(message.kind, message);
      port.postMessage(message);
    },
    receive: (raw) => {
      const message = parseOffscreenToSwMessage(raw);
      deps.traffic.recordReceived(message?.kind ?? "invalid", raw);

      if (!message) {
        return null;
      }

      if (message.kind === "offscreen.pipeline-response") {
        settle(message);
        return null;
      }

      return message;
    },
    rejectPending: (reason) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(reason));
      }

      pending.clear();
    },
    pendingCount: () => pending.size
  };
}

export function createSessionPipelineClient(
  client: OffscreenClient,
  sid: string
): SessionPipelineClient {
  return {
    start: async (session, redactionProfile, capturePolicy) => {
      await client.request({ op: "start", sid, session, redactionProfile, capturePolicy });
    },
    ingest: async (event) => {
      await client.request({ op: "ingest", sid, event });
    },
    ingestBatch: (events) => client.request({ op: "ingestBatch", sid, events }),
    flush: async () => {
      await client.request({ op: "flush", sid });
    },
    putBlob: (mime, bytes) =>
      client.request({ op: "putBlob", sid, mime, base64: bytesToBase64(bytes) }),
    exportAndDownload: (options = {}) =>
      client.request({
        op: "exportDownload",
        sid,
        passphrase: options.passphrase,
        includeScreenshots: options.includeScreenshots,
        includeScreenRecordings: options.includeScreenRecordings,
        maxArchiveBytes: options.maxArchiveBytes,
        recentWindowMs: options.recentWindowMs
      }),
    close: async (options = {}) => {
      await client.request({ op: "close", sid, purge: options.purge });
    }
  };
}

/** The offscreen document lost the pipeline or the port: worth recovering and retrying once. */
function isPipelineLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes(PIPELINE_SESSION_NOT_FOUND_ERROR) ||
    message.includes(OFFSCREEN_DISCONNECTED_ERROR) ||
    message.includes(OFFSCREEN_UNAVAILABLE_ERROR)
  );
}

function measureBinaryBytes(message: OffscreenPipelineRequestMessage): number {
  return message.op === "putBlob" ? base64DecodedLength(message.base64) : 0;
}
