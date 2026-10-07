import type { CdpRouter } from "@webblackbox/cdp-router";
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { BODY_SKIPPED_RAW_TYPE, type RawRecorderEvent } from "@webblackbox/recorder";

import { resolveSourceMapCapture, type SourceMapCapture } from "../shared/profiles/resolve.js";
import { transformResponseBodyForCapture, type BodyCaptureRule } from "./body-capture-utils.js";
import { withCdpCommandTimeout, type CdpCommandOutcome } from "./cdp-command.js";
import { primeChildSession } from "./child-session-prime.js";
import {
  completeRequestPostData,
  FullBodyCapture,
  needsRequestPostData,
  type FinishedResponse,
  type ReadBody
} from "./full-body-capture.js";
import {
  buildRequestMetaKey,
  deleteRequestMeta,
  getRequestMeta,
  upsertRequestMeta
} from "./request-meta.js";
import type { SessionRuntime } from "./session-registry.js";
import {
  DEBUGGER_SCRIPT_CACHE_BYTES,
  loadSourceMapForEmbedding,
  SCRIPT_RAW_TYPE,
  scriptRecordFromResponse,
  scriptRecordFromScriptParsed,
  type RawScriptRecord
} from "./source-maps.js";

/** How long a CDP read (artifact or body) may take before it is reported as `timeout`. */
export const CDP_ARTIFACT_TIMEOUT_MS = 5_000;
/** Heap snapshot chunks kept per capture; later chunks mark the snapshot truncated. */
export const HEAP_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** CDP events waiting behind request body reads before new reads are skipped as `backlog`. */
const FULL_MODE_CDP_INGEST_MAX_BACKLOG = 500;
/** How long a request body CDP left out of `requestWillBeSent` may take to read. */
const FULL_MODE_POST_DATA_TIMEOUT_MS = 2_000;
const FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS = 12_000;
// Priming a live child session takes milliseconds; see primeChildSession.
const CHILD_SESSION_PRIME_TIMEOUT_MS = 5_000;
// Network bookkeeping for bodies runs inline (see `trackFullModeNetworkEvent`), never through
// the best-effort queue, which drops tasks under load.
const FULL_MODE_FOLLOWUP_METHODS = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Network.loadingFailed",
  "Runtime.exceptionThrown",
  "Page.frameNavigated"
]);
// Child sessions (iframes, workers) must be primed or their traffic is never recorded.
const FULL_MODE_REQUIRED_FOLLOWUP_METHODS = new Set(["Target.attachedToTarget"]);

/**
 * What the full-mode CDP plumbing needs from the service worker: event ingestion, the session
 * queue, session stop on debugger detach, the artifact captures (screenshots, traces, profiles)
 * and the body capture policy. Everything stateful stays on `SessionRuntime`.
 */
export type FullCdpDeps = {
  createRouter: () => CdpRouter;
  ingestRawEvent: (rawEvent: RawRecorderEvent, options?: { arrivedBeforeStop?: boolean }) => void;
  enqueue: (
    runtime: SessionRuntime,
    task: () => Promise<void>,
    options?: { bestEffort?: boolean }
  ) => boolean;
  stopSession: (tabId: number) => Promise<void>;
  captureFullModeArtifacts: (runtime: SessionRuntime, reason: string) => Promise<void>;
  captureScreenshot: (runtime: SessionRuntime, reason: string) => Promise<void>;
  shouldCaptureIncidentArtifacts: (runtime: SessionRuntime) => boolean;
  captureIncidentArtifacts: (runtime: SessionRuntime, reason: string) => Promise<void>;
  resolveBodyRule: (
    runtime: SessionRuntime,
    url: string,
    mimeType: string | undefined
  ) => BodyCaptureRule;
  /** Token replacing redacted body content, shared with lite-mode body capture. */
  bodyRedactedToken: string;
};

export type FullCdpController = {
  attachCdp: (runtime: SessionRuntime) => Promise<void>;
  /** Matches `SessionRuntimeDeps.createFullBodyCapture`; wired into every session runtime. */
  createFullBodyCapture: (getRuntime: () => SessionRuntime) => FullBodyCapture;
  cleanupCdpInstrumentation: (runtime: SessionRuntime, router: CdpRouter | null) => Promise<void>;
  recordScriptSourceMap: (runtime: SessionRuntime, record: RawScriptRecord | null) => void;
};

export function createFullCdpController(deps: FullCdpDeps): FullCdpController {
  async function attachCdp(runtime: SessionRuntime): Promise<void> {
    let router: CdpRouter | null = null;

    try {
      router = deps.createRouter();

      const unsubscribeEvent = router.onEvent((event) => {
        // Raw CDP params go to the recorder, whose normalizer allowlists fields and gates bodies.
        const cdpPayload = event.params ?? {};

        if (event.method === "HeapProfiler.addHeapSnapshotChunk") {
          const payload = asRecord(cdpPayload);
          const chunk = typeof payload?.chunk === "string" ? payload.chunk : undefined;

          if (chunk && runtime.heapSnapshotCapture) {
            const chunkBytes = new TextEncoder().encode(chunk).byteLength;
            const nextBytes = runtime.heapSnapshotCapture.bytes + chunkBytes;

            if (nextBytes <= HEAP_SNAPSHOT_MAX_BYTES) {
              runtime.heapSnapshotCapture.chunks.push(chunk);
              runtime.heapSnapshotCapture.bytes = nextBytes;
            } else {
              runtime.heapSnapshotCapture.truncated = true;
            }
          }
        }

        // One event per parsed script (eval and extension code included): handled inline instead
        // of through the recorder or the best-effort follow-up queue.
        if (event.method === "Debugger.scriptParsed") {
          recordScriptSourceMap(runtime, scriptRecordFromScriptParsed(cdpPayload));
          return;
        }

        const rawEvent: RawRecorderEvent = {
          source: "cdp",
          rawType: event.method,
          tabId: runtime.tabId,
          sid: runtime.sid,
          t: Date.now(),
          mono: monotonicTime(),
          cdpSessionId: event.sessionId,
          payload: cdpPayload
        };

        ingestCdpRawEvent(
          runtime,
          event.method === "Network.requestWillBeSent"
            ? prepareCdpRequestEvent(runtime, rawEvent)
            : rawEvent
        );

        if (!runtime.stopping) {
          trackFullModeNetworkEvent(runtime, event.method, asRecord(cdpPayload), event.sessionId);
        }

        if (!FULL_MODE_FOLLOWUP_METHODS.has(event.method)) {
          return;
        }

        deps.enqueue(
          runtime,
          async () => {
            await processFullModeEvent(runtime, event.method, event.params ?? {});
          },
          { bestEffort: !FULL_MODE_REQUIRED_FOLLOWUP_METHODS.has(event.method) }
        );
      });

      const unsubscribeDetach = router.onDetach((event) => {
        if (event.tabId === runtime.tabId) {
          void deps.stopSession(runtime.tabId);
        }
      });

      runtime.removeCdpListeners.push(unsubscribeEvent, unsubscribeDetach);

      await router.attach(runtime.tabId);
      // Set before the domains are enabled: their first events already read bodies through it.
      runtime.cdpRouter = router;
      runtime.enabledCdpSessions.clear();
      await router.enableBaseline(runtime.tabId);
      runtime.enabledCdpSessions.add("root");
      await router.enableAutoAttach(runtime.tabId);
      await router.send({ tabId: runtime.tabId }, "DOMStorage.enable").catch((error: unknown) => {
        console.warn("[WebBlackbox] failed to enable DOMStorage domain", {
          sid: runtime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      await router.send({ tabId: runtime.tabId }, "Performance.enable").catch((error: unknown) => {
        console.warn("[WebBlackbox] failed to enable Performance domain", {
          sid: runtime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      await enableScriptDebugger(runtime, router, { tabId: runtime.tabId });

      runtime.cdpRouter = router;

      deps.enqueue(
        runtime,
        async () => {
          await deps.captureFullModeArtifacts(runtime, "session-start");
        },
        { bestEffort: true }
      );

      const normalizedScreenshotIntervalMs = normalizeOptionalSamplingInterval(
        runtime.config.sampling.screenshotIdleMs,
        DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
      );

      if (normalizedScreenshotIntervalMs > 0) {
        const screenshotIntervalMs = Math.max(
          FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS,
          normalizedScreenshotIntervalMs
        );

        runtime.screenshotInterval = globalThis.setInterval(() => {
          deps.enqueue(
            runtime,
            async () => {
              await deps.captureScreenshot(runtime, "interval");
            },
            { bestEffort: true }
          );
        }, screenshotIntervalMs);
      }
    } catch (error) {
      await cleanupCdpInstrumentation(runtime, router);
      console.warn("[WebBlackbox] failed to attach debugger", error);
    }
  }

  async function processFullModeEvent(
    runtime: SessionRuntime,
    method: string,
    params: unknown
  ): Promise<void> {
    if (runtime.stopping) {
      return;
    }

    const payload = asRecord(params);

    if (method === "Target.attachedToTarget") {
      const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

      if (childSessionId) {
        await primeChildCdpSession(runtime, childSessionId);
      }

      return;
    }

    if (method === "Target.detachedFromTarget") {
      const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

      if (childSessionId) {
        runtime.enabledCdpSessions.delete(childSessionId);
      }

      return;
    }

    if (method === "Runtime.exceptionThrown" || method === "Network.loadingFailed") {
      if (deps.shouldCaptureIncidentArtifacts(runtime)) {
        await deps.captureIncidentArtifacts(runtime, method);
      }

      return;
    }
  }

  async function primeChildCdpSession(
    runtime: SessionRuntime,
    childSessionId: string
  ): Promise<void> {
    if (!runtime.cdpRouter || runtime.enabledCdpSessions.has(childSessionId)) {
      return;
    }

    runtime.enabledCdpSessions.add(childSessionId);

    const primed = await primeChildSession(
      runtime.cdpRouter,
      runtime.tabId,
      childSessionId,
      CHILD_SESSION_PRIME_TIMEOUT_MS
    );

    if (!primed) {
      runtime.enabledCdpSessions.delete(childSessionId);
      return;
    }

    // Bounded like the priming: a child that is gone may never answer, and this runs on the
    // session's serial queue. enableScriptDebugger logs its own failures.
    await withCdpCommandTimeout(
      enableScriptDebugger(runtime, runtime.cdpRouter, {
        tabId: runtime.tabId,
        sessionId: childSessionId
      }),
      CHILD_SESSION_PRIME_TIMEOUT_MS
    );
  }

  function resolveRuntimeSourceMapCapture(runtime: SessionRuntime): SourceMapCapture {
    return resolveSourceMapCapture(runtime.profile.selection.profile, runtime.mode);
  }

  /**
   * Turns on `Debugger.scriptParsed` (which also reports scripts loaded before recording started)
   * when the profile records source maps. Pauses are skipped so `debugger;` statements and
   * breakpoints never stop the page.
   */
  async function enableScriptDebugger(
    runtime: SessionRuntime,
    router: CdpRouter,
    target: { tabId: number; sessionId?: string }
  ): Promise<void> {
    if (resolveRuntimeSourceMapCapture(runtime).mode === "off") {
      return;
    }

    try {
      await router.send(target, "Debugger.enable", {
        maxScriptsCacheSize: DEBUGGER_SCRIPT_CACHE_BYTES
      });
      await router.send(target, "Debugger.setSkipAllPauses", { skip: true });
    } catch (error) {
      console.warn("[WebBlackbox] failed to enable script source map capture", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Records a script's source map reference once per session and, when the profile embeds maps,
   * stores the map as a blob and records it in a follow-up event.
   */
  function recordScriptSourceMap(runtime: SessionRuntime, record: RawScriptRecord | null): void {
    if (!record || runtime.stopping) {
      return;
    }

    const capture = resolveRuntimeSourceMapCapture(runtime);

    if (capture.mode === "off" || !runtime.scriptSourceMaps.markRecorded(record)) {
      return;
    }

    ingestScriptRecord(runtime, record);

    if (capture.mode !== "embed" || !runtime.scriptSourceMaps.reserveEmbed(record)) {
      return;
    }

    // Fetched outside the session queue (which also carries pipeline flushes and CDP follow-ups),
    // so slow or large maps never hold up capture; only the blob write is queued.
    void runtime
      .scriptSourceMapFetches(() => embedScriptSourceMap(runtime, record, capture.maxMapBytes))
      .catch((error: unknown) => {
        console.warn("[WebBlackbox] failed to embed source map", {
          sid: runtime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async function embedScriptSourceMap(
    runtime: SessionRuntime,
    record: RawScriptRecord,
    maxMapBytes: number
  ): Promise<void> {
    if (runtime.stopping) {
      return;
    }

    const tracker = runtime.scriptSourceMaps;
    const result = await loadSourceMapForEmbedding(record, {
      maxBytes: Math.min(maxMapBytes, tracker.remainingEmbedBytes())
    });

    // A late result must not land in a later session on the same tab.
    if (runtime.stopping) {
      return;
    }

    if (!result.ok) {
      ingestScriptRecord(runtime, { ...record, mapError: result.error });
      return;
    }

    if (!tracker.tryAddEmbeddedBytes(result.bytes.byteLength)) {
      ingestScriptRecord(runtime, { ...record, mapError: "session source map budget exhausted" });
      return;
    }

    deps.enqueue(runtime, async () => {
      if (runtime.stopping) {
        return;
      }

      const contentHash = await runtime.pipeline.putBlob("application/json", result.bytes);

      ingestScriptRecord(runtime, {
        ...record,
        map: { contentHash, size: result.bytes.byteLength }
      });
    });
  }

  function ingestScriptRecord(
    runtime: SessionRuntime,
    payload: RawScriptRecord & { map?: { contentHash: string; size: number }; mapError?: string }
  ): void {
    deps.ingestRawEvent({
      source: "system",
      rawType: SCRIPT_RAW_TYPE,
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload
    });
  }

  function isFullBodyCaptureEnabled(runtime: SessionRuntime): boolean {
    return (
      runtime.mode === "full" &&
      runtime.config.capturePolicy?.categories.network === "body-allowlist"
    );
  }

  function createFullBodyCapture(getRuntime: () => SessionRuntime): FullBodyCapture {
    return new FullBodyCapture({
      isEnabled: () => isFullBodyCaptureEnabled(getRuntime()),
      resolveRule: (url, mimeType) => deps.resolveBodyRule(getRuntime(), url, mimeType),
      readResponseBody: (requestId, sessionId) =>
        readCdpForBodies(getRuntime(), sessionId, "Network.getResponseBody", { requestId }),
      storeBody: (response, read, rule, mimeType) =>
        storeFullModeResponseBody(getRuntime(), response, read, rule.maxBytes, mimeType),
      emitSkip: (payload) => {
        const runtime = getRuntime();
        ingestCdpRawEvent(runtime, {
          source: "system",
          rawType: BODY_SKIPPED_RAW_TYPE,
          sid: runtime.sid,
          tabId: runtime.tabId,
          t: Date.now(),
          mono: monotonicTime(),
          payload
        });
      }
    });
  }

  /**
   * CDP reads for body capture. Unlike `sendCdpCommand` they still run while the session stops
   * (stop drains pending bodies before the debugger detaches) and report the CDP error text.
   */
  async function readCdpForBodies<TResult>(
    runtime: SessionRuntime,
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
  ): Promise<CdpCommandOutcome<TResult>> {
    if (!runtime.cdpRouter) {
      return { ok: false, error: "debugger detached" };
    }

    const target = sessionId ? { tabId: runtime.tabId, sessionId } : { tabId: runtime.tabId };
    return withCdpCommandTimeout(
      runtime.cdpRouter.send<TResult>(target, method, params),
      timeoutMs
    );
  }

  async function storeFullModeResponseBody(
    runtime: SessionRuntime,
    response: FinishedResponse,
    read: ReadBody,
    maxBytes: number,
    mimeType: string | undefined
  ): Promise<number> {
    const transformed = transformResponseBodyForCapture({
      body: read.body,
      base64Encoded: read.base64Encoded,
      redaction: runtime.config.redaction,
      maxBytes,
      mimeType,
      redactionToken: deps.bodyRedactedToken,
      decodeBase64
    });
    const rawMimeType = response.meta?.mimeType;
    const hash = await runtime.pipeline.putBlob(
      rawMimeType ?? "application/octet-stream",
      transformed.sampledBytes
    );

    ingestCdpRawEvent(runtime, {
      source: "system",
      rawType: "cdp.network.body",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        reqId: response.requestId,
        contentHash: hash,
        mimeType: rawMimeType,
        size: transformed.originalBytes.byteLength,
        sampledSize: transformed.sampledBytes.byteLength,
        redacted: transformed.redacted,
        truncated: transformed.truncated
      }
    });

    return transformed.sampledBytes.byteLength;
  }

  /**
   * Keeps request ids and response metadata for body capture, inline on every CDP event: a dropped
   * bookkeeping task would lose the body silently.
   */
  function trackFullModeNetworkEvent(
    runtime: SessionRuntime,
    method: string,
    payload: Record<string, unknown> | null,
    sessionId: string | undefined
  ): void {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

    if (!requestId) {
      return;
    }

    const metaKey = buildRequestMetaKey(requestId, sessionId);

    if (method === "Network.requestWillBeSent") {
      runtime.fullBodyCapture.onRequestWillBeSent(requestId, sessionId);
      return;
    }

    if (method === "Network.responseReceived") {
      recordScriptSourceMap(runtime, scriptRecordFromResponse(payload));
      const response = asRecord(payload?.response);
      upsertRequestMeta(runtime.requestMeta, metaKey, {
        url: typeof response?.url === "string" ? response.url : undefined,
        mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
        status: typeof response?.status === "number" ? response.status : undefined,
        resourceType: typeof payload?.type === "string" ? payload.type : undefined,
        // Bytes received when the response arrived: its headers (the body follows).
        headerBytes: asFiniteNumber(response?.encodedDataLength) ?? undefined
      });
      runtime.fullBodyCapture.onResponseReceived({
        requestId,
        sessionId,
        meta: getRequestMeta(runtime.requestMeta, metaKey)
      });
      return;
    }

    if (method === "Network.loadingFinished") {
      const encodedDataLength = asFiniteNumber(payload?.encodedDataLength);
      runtime.fullBodyCapture.onLoadingFinished({
        requestId,
        sessionId,
        encodedDataLength:
          encodedDataLength !== null && encodedDataLength >= 0 ? encodedDataLength : undefined,
        meta: getRequestMeta(runtime.requestMeta, metaKey)
      });
      deleteRequestMeta(runtime.requestMeta, metaKey);
      return;
    }

    if (method === "Network.loadingFailed") {
      runtime.fullBodyCapture.onLoadingFailed(requestId, sessionId);
      deleteRequestMeta(runtime.requestMeta, metaKey);
    }
  }

  /**
   * Ingests a CDP-side raw event in arrival order. While a request body CDP left out is being read,
   * later events wait behind it, so the request still comes before its response.
   */
  function ingestCdpRawEvent(
    runtime: SessionRuntime,
    rawEvent: RawRecorderEvent | Promise<RawRecorderEvent>
  ): void {
    if (runtime.cdpIngestBacklog === 0 && !(rawEvent instanceof Promise)) {
      deps.ingestRawEvent(rawEvent);
      return;
    }

    const arrivedBeforeStop = !runtime.stopping;
    runtime.cdpIngestBacklog += 1;
    runtime.cdpIngestChain = runtime.cdpIngestChain
      .then(async () => {
        deps.ingestRawEvent(await rawEvent, { arrivedBeforeStop });
      })
      .catch((error) => {
        console.warn("[WebBlackbox] failed to ingest a CDP event", error);
      })
      .finally(() => {
        runtime.cdpIngestBacklog = Math.max(0, runtime.cdpIngestBacklog - 1);
      });
  }

  /** The `requestWillBeSent` raw event, with a body CDP did not inline read when bodies are on. */
  function prepareCdpRequestEvent(
    runtime: SessionRuntime,
    rawEvent: RawRecorderEvent
  ): RawRecorderEvent | Promise<RawRecorderEvent> {
    const payload = asRecord(rawEvent.payload);

    if (!isFullBodyCaptureEnabled(runtime) || !payload || !needsRequestPostData(payload)) {
      return rawEvent;
    }

    const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;

    if (!requestId) {
      return rawEvent;
    }

    // Events wait behind pending reads; past this backlog the body is recorded as skipped instead.
    if (runtime.cdpIngestBacklog >= FULL_MODE_CDP_INGEST_MAX_BACKLOG) {
      const request = asRecord(payload.request) ?? {};
      return {
        ...rawEvent,
        payload: { ...payload, request: { ...request, postDataSkipped: "backlog" } }
      };
    }

    return completeRequestPostData(payload, () =>
      readCdpForBodies<{ postData?: string }>(
        runtime,
        rawEvent.cdpSessionId,
        "Network.getRequestPostData",
        { requestId },
        FULL_MODE_POST_DATA_TIMEOUT_MS
      )
    ).then((completed) => ({ ...rawEvent, payload: completed }));
  }

  async function cleanupCdpInstrumentation(
    runtime: SessionRuntime,
    router: CdpRouter | null
  ): Promise<void> {
    if (runtime.screenshotInterval !== null) {
      clearInterval(runtime.screenshotInterval);
      runtime.screenshotInterval = null;
    }

    if (router) {
      await router.detach(runtime.tabId).catch((error: unknown) => {
        console.warn("[WebBlackbox] failed to detach debugger", {
          sid: runtime.sid,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    for (const dispose of runtime.removeCdpListeners.splice(0, runtime.removeCdpListeners.length)) {
      dispose();
    }

    router?.dispose();

    if (runtime.cdpRouter === router) {
      runtime.cdpRouter = null;
    }

    runtime.enabledCdpSessions.clear();
    runtime.requestMeta.clear();
    runtime.fullBodyCapture.close();
    runtime.heapSnapshotCapture = null;
  }

  return {
    attachCdp,
    createFullBodyCapture,
    cleanupCdpInstrumentation,
    recordScriptSourceMap
  };
}

/** Lite pages scan their own scripts for map references when the profile asks for it. */
export function toScriptScanStatus(runtime: SessionRuntime): { scriptSourceMaps?: true } {
  return runtime.mode === "lite" &&
    resolveSourceMapCapture(runtime.profile.selection.profile, runtime.mode).mode !== "off"
    ? { scriptSourceMaps: true }
    : {};
}

/** Lite scanner records arrive as content events with full URLs. */
export function readContentScriptRecord(payload: unknown): RawScriptRecord | null {
  const row = asRecord(payload);
  const url = typeof row?.url === "string" ? row.url : "";
  const sourceMapUrl = typeof row?.sourceMapUrl === "string" ? row.sourceMapUrl : "";
  const origin = row?.origin === "header" ? "header" : row?.origin === "comment" ? "comment" : null;

  return url && sourceMapUrl && origin ? { url, sourceMapUrl, origin } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    return new TextEncoder().encode(value);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function normalizeOptionalSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(250, Math.round(value));
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}
