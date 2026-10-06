import { FlightRecorderPipeline } from "@webblackbox/pipeline";
import type { PrivacyScannerResult } from "@webblackbox/protocol";

import { STORAGE_KEY_MESSAGE_KIND } from "../shared/at-rest.js";
import { base64ToBytes } from "../shared/base64.js";
import { getChromeApi, type PortLike } from "../shared/chrome-api.js";
import { createExtensionI18n } from "../shared/i18n.js";
import { PORT_NAMES } from "../shared/messages.js";
import {
  OFFSCREEN_CONNECT_REQUEST_KIND,
  parsePipelineRequest,
  parseSwToOffscreenMessage,
  PIPELINE_RESPONSE_KIND,
  PIPELINE_SESSION_NOT_FOUND_ERROR,
  type OffscreenPipelineRequestFor,
  type OffscreenPipelineRequestMessage,
  type OffscreenToSwMessage,
  type ScreenRecordingStartResult,
  type ScreenRecordingStopResult
} from "../shared/offscreen-messages.js";
import { createAtRestStorageProvider } from "./at-rest-storage.js";

type OffscreenState = {
  active: boolean;
  activeSessions: number;
  updatedAt: number | null;
};

type OffscreenScreenRecordingState = {
  sid: string;
  recordingId: string;
  source: "tab";
  stream: MediaStream;
  recorder: MediaRecorder;
  mime: string;
  startedAt: number;
  width?: number;
  height?: number;
  frameRate?: number;
  nextChunkIndex: number;
  storedChunkCount: number;
  sizeBytes: number;
  pendingChunks: Set<Promise<void>>;
  stopping: boolean;
  stopPromise: Promise<ScreenRecordingStopResult> | null;
};

const chromeApi = getChromeApi();
createExtensionI18n({
  pageTitleKey: "pageTitleOffscreen"
});
const pipelines = new Map<string, FlightRecorderPipeline>();
// Every pipeline writes through this AES-GCM storage once the service worker sends the key.
const atRestStorage = createAtRestStorageProvider({
  onPurged: (result) => {
    if (result.deleted.length > 0 || result.failed.length > 0) {
      console.info("[WebBlackbox] purged unreadable recordings from local storage", {
        deleted: result.deleted.length,
        failed: result.failed.length
      });
    }
  },
  onPurgeError: (error) => {
    console.warn("[WebBlackbox] failed to purge unreadable recordings", error);
  }
});
const screenRecordings = new Map<string, OffscreenScreenRecordingState>();
const EXPORT_OBJECT_URL_TTL_MS = 90_000;
const SERVICE_WORKER_KEEPALIVE_INTERVAL_MS = 20_000;
const SCREEN_RECORDING_TIMESLICE_MS = 1_000;
const SCREEN_RECORDING_STOP_TIMEOUT_MS = 10_000;
const SCREEN_RECORDING_MAX_FRAME_RATE = 30;
const SCREEN_RECORDING_VIDEO_BITS_PER_SECOND = 3_500_000;
const SCREEN_RECORDING_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm"
];
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;
const RECONNECT_MAX_ATTEMPTS = 8;

const state: OffscreenState = {
  active: false,
  activeSessions: 0,
  updatedAt: null
};

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let port: PortLike | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

console.info("[WebBlackbox] offscreen pipeline initialized");

chromeApi?.runtime?.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOffscreenConnectRequest(message) || sender.tab) {
    return;
  }

  connectToServiceWorker();
  sendResponse({ ok: true });
});

connectToServiceWorker();

/**
 * Opens the pipeline port to the service worker. The port dies with the worker
 * (MV3 terminates idle workers); a restarted worker asks us to reconnect through
 * `sw.offscreen-connect`, and we reconnect on our own only while capture is live.
 */
function connectToServiceWorker(): void {
  if (port || !chromeApi?.runtime?.connect) {
    return;
  }

  clearReconnectTimer();

  const nextPort = chromeApi.runtime.connect({ name: PORT_NAMES.offscreen });
  port = nextPort;
  nextPort.onMessage.addListener(handleServiceWorkerMessage);
  nextPort.onDisconnect.addListener(() => {
    if (port !== nextPort) {
      return;
    }

    port = null;
    stopServiceWorkerKeepalive();
    scheduleReconnectWhileBusy();
  });

  postToSw({
    kind: "offscreen.ready",
    t: Date.now()
  });
}

function scheduleReconnectWhileBusy(): void {
  // Reconnecting wakes the worker, so only do it when capture would otherwise be lost.
  if (screenRecordings.size === 0 && state.activeSessions === 0) {
    reconnectAttempts = 0;
    return;
  }

  if (reconnectTimer !== null || reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    return;
  }

  const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServiceWorker();
  }, delay);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function isOffscreenConnectRequest(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === "object" &&
    (message as { kind?: unknown }).kind === OFFSCREEN_CONNECT_REQUEST_KIND
  );
}

function handleServiceWorkerMessage(raw: unknown): void {
  const message = parseSwToOffscreenMessage(raw);

  if (!message) {
    answerMalformedRequest(raw);
    return;
  }

  switch (message.kind) {
    case "sw.recording-status":
      state.active = message.active;
      console.info("[WebBlackbox] offscreen status", message);
      return;
    case "sw.pipeline-status":
      state.activeSessions = message.activeSessions;
      state.updatedAt = message.updatedAt;
      reconnectAttempts = 0;
      syncServiceWorkerKeepalive();

      console.info("[WebBlackbox] offscreen pipeline status", {
        active: state.active,
        activeSessions: state.activeSessions,
        updatedAt: state.updatedAt
      });
      return;
    case STORAGE_KEY_MESSAGE_KIND:
      void atRestStorage.acceptKey(message).catch((error) => {
        console.warn("[WebBlackbox] failed to install the at-rest encryption key", error);
      });
      return;
    case "sw.pipeline-request":
      void handlePipelineRequest(message);
      return;
  }
}

/** Answers a request that failed the checks, so the worker does not wait for its timeout. */
function answerMalformedRequest(raw: unknown): void {
  const parsed = parsePipelineRequest(raw);

  if (parsed.ok || !parsed.requestId) {
    return;
  }

  console.warn("[WebBlackbox] rejected a malformed pipeline request", parsed.error);
  postToSw({
    kind: PIPELINE_RESPONSE_KIND,
    requestId: parsed.requestId,
    ok: false,
    error: parsed.error
  });
}

async function handlePipelineRequest(message: OffscreenPipelineRequestMessage): Promise<void> {
  try {
    const result = await processPipelineRequest(message);
    postToSw({
      kind: PIPELINE_RESPONSE_KIND,
      requestId: message.requestId,
      ok: true,
      result
    });
  } catch (error) {
    postToSw({
      kind: PIPELINE_RESPONSE_KIND,
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function processPipelineRequest(message: OffscreenPipelineRequestMessage): Promise<unknown> {
  if (message.op === "start") {
    if (pipelines.has(message.sid)) {
      return null;
    }

    const storage = await atRestStorage.getStorage();
    const pipeline = new FlightRecorderPipeline({
      session: message.session,
      storage,
      maxChunkBytes: 512 * 1024,
      redactionProfile: message.redactionProfile,
      capturePolicy: message.capturePolicy
    });

    await pipeline.start();
    pipelines.set(message.sid, pipeline);
    return null;
  }

  const pipeline = pipelines.get(message.sid);

  if (!pipeline) {
    throw new Error(`${PIPELINE_SESSION_NOT_FOUND_ERROR}: ${message.sid}`);
  }

  switch (message.op) {
    case "startScreenRecording":
      return startOffscreenScreenRecording(message);
    case "stopScreenRecording":
      return stopOffscreenScreenRecording(
        message.sid,
        message.recordingId,
        message.reason ?? "requested",
        false
      );
    case "ingest":
      await pipeline.ingest(message.event);
      return null;
    case "ingestBatch":
      return message.events.length === 0 ? 0 : pipeline.ingestBatch(message.events);
    case "flush":
      await pipeline.flush();
      return null;
    case "putBlob":
      return pipeline.putBlob(message.mime, base64ToBytes(message.base64));
    case "exportDownload": {
      const exported = await pipeline.exportBundle({
        passphrase: message.passphrase,
        includeScreenshots: message.includeScreenshots,
        includeScreenRecordings: message.includeScreenRecordings,
        maxArchiveBytes: message.maxArchiveBytes,
        recentWindowMs: message.recentWindowMs
      });
      return downloadExportedBundle(
        exported.fileName,
        exported.bytes,
        exported.integrity,
        exported.privacyManifest.scanner
      );
    }
    case "close":
      await closeSessionPipeline(message.sid, pipeline, message.purge === true);
      return null;
  }
}

async function closeSessionPipeline(
  sid: string,
  pipeline: FlightRecorderPipeline,
  purge: boolean
): Promise<void> {
  // The tab video is normally stopped and saved at session stop; only a still-live one needs stopping.
  if (screenRecordings.has(sid)) {
    await stopOffscreenScreenRecording(
      sid,
      undefined,
      purge ? "pipeline-purge" : "pipeline-close",
      false
    ).catch((error) => {
      console.warn("[WebBlackbox] failed to stop offscreen screen recording", error);
    });
  }

  await pipeline.close({ purge });
  pipelines.delete(sid);
}

function postToSw(message: OffscreenToSwMessage): void {
  try {
    port?.postMessage(message);
  } catch {
    void 0;
  }
}

function syncServiceWorkerKeepalive(): void {
  if (state.activeSessions > 0 || screenRecordings.size > 0) {
    startServiceWorkerKeepalive();
    return;
  }

  stopServiceWorkerKeepalive();
}

function startServiceWorkerKeepalive(): void {
  if (keepaliveTimer !== null) {
    return;
  }

  postServiceWorkerKeepalive();
  keepaliveTimer = setInterval(postServiceWorkerKeepalive, SERVICE_WORKER_KEEPALIVE_INTERVAL_MS);
}

function stopServiceWorkerKeepalive(): void {
  if (keepaliveTimer === null) {
    return;
  }

  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function postServiceWorkerKeepalive(): void {
  postToSw({
    kind: "offscreen.keepalive",
    activeSessions: state.activeSessions,
    t: Date.now()
  });
}

async function startOffscreenScreenRecording(
  message: OffscreenPipelineRequestFor<"startScreenRecording">
): Promise<ScreenRecordingStartResult> {
  const { recordingId, streamId } = message;
  const existing = screenRecordings.get(message.sid);

  if (existing) {
    if (existing.recordingId !== recordingId) {
      throw new Error(`Screen recording already active for session: ${message.sid}`);
    }

    return toScreenRecordingStartResult(existing);
  }

  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia(
      createTabCaptureConstraints(streamId, SCREEN_RECORDING_MAX_FRAME_RATE)
    );

    const videoTrack = stream.getVideoTracks()[0];

    if (!videoTrack) {
      throw new Error("Tab capture stream did not include a video track.");
    }

    const settings = videoTrack.getSettings();
    const mime = selectScreenRecordingMime();
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: SCREEN_RECORDING_VIDEO_BITS_PER_SECOND
    });
    const recording: OffscreenScreenRecordingState = {
      sid: message.sid,
      recordingId,
      source: "tab",
      stream,
      recorder,
      mime: recorder.mimeType || mime,
      startedAt: performance.now(),
      width: normalizePositiveInteger(settings.width),
      height: normalizePositiveInteger(settings.height),
      frameRate: normalizePositiveNumber(settings.frameRate),
      nextChunkIndex: 0,
      storedChunkCount: 0,
      sizeBytes: 0,
      pendingChunks: new Set(),
      stopping: false,
      stopPromise: null
    };

    recorder.ondataavailable = (event) => {
      handleScreenRecordingData(recording, event.data);
    };
    recorder.onerror = (event) => {
      postScreenRecordingError(
        recording.sid,
        recording.recordingId,
        extractErrorFromRecorderEvent(event),
        "recorder"
      );
    };
    videoTrack.addEventListener("ended", () => {
      if (!recording.stopping) {
        void stopOffscreenScreenRecording(
          recording.sid,
          recording.recordingId,
          "track-ended",
          true
        );
      }
    });

    screenRecordings.set(message.sid, recording);
    syncServiceWorkerKeepalive();
    recorder.start(SCREEN_RECORDING_TIMESLICE_MS);

    return toScreenRecordingStartResult(recording);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    postScreenRecordingError(message.sid, recordingId, error, "start");
    throw error;
  }
}

async function stopOffscreenScreenRecording(
  sid: string,
  recordingId: string | undefined,
  reason: string,
  notifyEnded: boolean
): Promise<ScreenRecordingStopResult> {
  const recording = screenRecordings.get(sid);

  if (!recording) {
    if (!recordingId) {
      throw new Error(`Screen recording not found for session: ${sid}`);
    }

    return {
      recordingId,
      mime: "video/webm",
      chunkCount: 0,
      size: 0,
      durationMs: 0,
      reason
    };
  }

  if (recordingId && recording.recordingId !== recordingId) {
    throw new Error(`Screen recording id mismatch for session: ${sid}`);
  }

  if (!recording.stopPromise) {
    recording.stopPromise = stopActiveOffscreenScreenRecording(recording, reason);
  }

  const result = await recording.stopPromise;

  if (notifyEnded) {
    postToSw({
      kind: "offscreen.screen-recording-ended",
      sid,
      result
    });
  }

  return result;
}

async function stopActiveOffscreenScreenRecording(
  recording: OffscreenScreenRecordingState,
  reason: string
): Promise<ScreenRecordingStopResult> {
  recording.stopping = true;

  return new Promise((resolve) => {
    let finished = false;
    const timeout = setTimeout(() => {
      void finish();
    }, SCREEN_RECORDING_STOP_TIMEOUT_MS);

    const finish = async (): Promise<void> => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      await waitForOffscreenScreenRecordingChunks(recording);
      cleanupOffscreenScreenRecording(recording);
      resolve(toScreenRecordingStopResult(recording, reason));
    };

    recording.recorder.addEventListener(
      "stop",
      () => {
        void finish();
      },
      { once: true }
    );

    try {
      if (recording.recorder.state !== "inactive") {
        recording.recorder.requestData();
        recording.recorder.stop();
        return;
      }
    } catch (error) {
      postScreenRecordingError(recording.sid, recording.recordingId, error, "stop");
    }

    void finish();
  });
}

function handleScreenRecordingData(
  recording: OffscreenScreenRecordingState,
  blob: Blob | null | undefined
): void {
  if (!blob || blob.size <= 0) {
    return;
  }

  const index = recording.nextChunkIndex;
  const startOffsetMs = Math.max(0, Math.round(performance.now() - recording.startedAt));
  recording.nextChunkIndex += 1;

  // The chunk goes straight into the session's pipeline; the worker only gets its hash.
  const task = (async () => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const endOffsetMs = Math.max(0, Math.round(performance.now() - recording.startedAt));
    const pipeline = pipelines.get(recording.sid);

    if (!pipeline) {
      throw new Error(`${PIPELINE_SESSION_NOT_FOUND_ERROR}: ${recording.sid}`);
    }

    const mime = blob.type || recording.mime;
    const chunkId = await pipeline.putBlob(mime, bytes);
    recording.storedChunkCount += 1;
    recording.sizeBytes += bytes.byteLength;

    postToSw({
      kind: "offscreen.screen-recording-chunk",
      sid: recording.sid,
      recordingId: recording.recordingId,
      index,
      mime,
      chunkId,
      size: bytes.byteLength,
      startOffsetMs,
      endOffsetMs,
      durationMs: Math.max(0, endOffsetMs - startOffsetMs)
    });
  })();

  recording.pendingChunks.add(task);
  task.then(
    () => {
      recording.pendingChunks.delete(task);
    },
    (error) => {
      recording.pendingChunks.delete(task);
      postScreenRecordingError(recording.sid, recording.recordingId, error, "chunk");
    }
  );
}

async function waitForOffscreenScreenRecordingChunks(
  recording: OffscreenScreenRecordingState
): Promise<void> {
  while (recording.pendingChunks.size > 0) {
    await Promise.allSettled([...recording.pendingChunks]);
  }
}

function cleanupOffscreenScreenRecording(recording: OffscreenScreenRecordingState): void {
  recording.stream.getTracks().forEach((track) => track.stop());

  if (screenRecordings.get(recording.sid) === recording) {
    screenRecordings.delete(recording.sid);
  }

  syncServiceWorkerKeepalive();
}

function createTabCaptureConstraints(streamId: string, frameRate: number): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: frameRate
      }
    } as unknown as MediaTrackConstraints
  };
}

function selectScreenRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is unavailable in the offscreen document.");
  }

  for (const mime of SCREEN_RECORDING_MIME_CANDIDATES) {
    if (
      typeof MediaRecorder.isTypeSupported !== "function" ||
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime;
    }
  }

  return "video/webm";
}

function toScreenRecordingStartResult(
  recording: OffscreenScreenRecordingState
): ScreenRecordingStartResult {
  return {
    recordingId: recording.recordingId,
    source: recording.source,
    mime: recording.mime,
    width: recording.width,
    height: recording.height,
    frameRate: recording.frameRate,
    audio: recording.stream.getAudioTracks().length > 0
  };
}

function toScreenRecordingStopResult(
  recording: OffscreenScreenRecordingState,
  reason: string
): ScreenRecordingStopResult {
  return {
    recordingId: recording.recordingId,
    mime: recording.mime,
    chunkCount: recording.storedChunkCount,
    size: recording.sizeBytes,
    durationMs: Math.max(0, Math.round(performance.now() - recording.startedAt)),
    width: recording.width,
    height: recording.height,
    reason
  };
}

function postScreenRecordingError(
  sid: string,
  recordingId: string | undefined,
  error: unknown,
  stage: string
): void {
  postToSw({
    kind: "offscreen.screen-recording-error",
    sid,
    recordingId,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
    stage
  });
}

function extractErrorFromRecorderEvent(event: Event): unknown {
  const error = (event as Event & { error?: unknown }).error;
  return error instanceof Error || typeof error === "string" ? error : event;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function downloadExportedBundle(
  fileName: string,
  bytes: Uint8Array,
  integrity: unknown,
  privacyScanner: PrivacyScannerResult
): Promise<{
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  integrity: unknown;
  privacyScanner: PrivacyScannerResult;
}> {
  const blobPart: BlobPart =
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : Uint8Array.from(bytes);
  const blob = new Blob([blobPart], { type: "application/zip" });
  const downloadUrl = URL.createObjectURL(blob);

  scheduleObjectUrlRevoke(downloadUrl);

  return {
    fileName,
    sizeBytes: bytes.byteLength,
    downloadUrl,
    integrity,
    privacyScanner
  };
}

function scheduleObjectUrlRevoke(url: string): void {
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, EXPORT_OBJECT_URL_TTL_MS);
}
