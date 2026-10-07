import type { RawRecorderEvent } from "@webblackbox/recorder";

import type {
  ScreenRecordingChunkMessage,
  ScreenRecordingEndedMessage,
  ScreenRecordingErrorMessage,
  ScreenRecordingStopResult
} from "../shared/offscreen-messages.js";
import type { OffscreenClient } from "./offscreen-client.js";
import type { ScreenRecordingRuntime, SessionRuntime } from "./session-registry.js";

const SCREEN_RECORDING_OFFSCREEN_SOURCE = "tab";

type TabCaptureApi = {
  getMediaStreamId(options?: { targetTabId?: number; consumerTabId?: number }): Promise<string>;
};

/**
 * What screen recording needs from the service worker: the tabCapture permission, the offscreen
 * document that owns the recorder, the session index for offscreen callbacks and raw-event
 * ingestion. The recording state itself lives on `SessionRuntime.screenRecording`.
 */
export type ScreenRecordingDeps = {
  tabCapture: TabCaptureApi | undefined;
  /** Read lazily: the offscreen client is created after this controller in the worker. */
  getOffscreenClient: () => OffscreenClient;
  getRuntimeBySid: (sid: string) => SessionRuntime | undefined;
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
};

export type ScreenRecordingController = {
  shouldStartScreenRecording: (runtime: SessionRuntime) => boolean;
  startScreenRecording: (runtime: SessionRuntime) => Promise<void>;
  stopScreenRecording: (runtime: SessionRuntime, reason: string) => Promise<void>;
  handleOffscreenScreenRecordingChunk: (message: ScreenRecordingChunkMessage) => void;
  handleOffscreenScreenRecordingEnded: (message: ScreenRecordingEndedMessage) => Promise<void>;
  handleOffscreenScreenRecordingError: (message: ScreenRecordingErrorMessage) => void;
};

export function createScreenRecordingController(
  deps: ScreenRecordingDeps
): ScreenRecordingController {
  function shouldStartScreenRecording(runtime: SessionRuntime): boolean {
    return (
      runtime.mode === "full" &&
      runtime.config.capturePolicy?.categories.screenRecordings === "allow"
    );
  }

  async function startScreenRecording(runtime: SessionRuntime): Promise<void> {
    if (!deps.tabCapture?.getMediaStreamId) {
      throw new Error("Chrome tabCapture API is unavailable for screen recording.");
    }

    if (runtime.screenRecording) {
      return;
    }

    const recordingId = createScreenRecordingId(runtime.sid);
    const startedAt = Date.now();
    const startedMono = monotonicTime();
    const streamId = await deps.tabCapture.getMediaStreamId({
      targetTabId: runtime.tabId
    });

    if (!streamId) {
      throw new Error("Chrome did not grant a tab capture stream.");
    }

    const recording: ScreenRecordingRuntime = {
      recordingId,
      source: SCREEN_RECORDING_OFFSCREEN_SOURCE,
      startedAt,
      startedMono,
      mime: "video/webm",
      chunks: [],
      chunkCount: 0,
      sizeBytes: 0,
      stopPromise: null
    };
    runtime.screenRecording = recording;

    try {
      const result = await deps.getOffscreenClient().request({
        op: "startScreenRecording",
        sid: runtime.sid,
        recordingId,
        streamId,
        source: SCREEN_RECORDING_OFFSCREEN_SOURCE
      });

      recording.mime = result.mime;
      recording.width = result.width;
      recording.height = result.height;
      recording.frameRate = result.frameRate;

      deps.ingestRawEvent({
        source: "system",
        rawType: "screen.recording.start",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: startedAt,
        mono: startedMono,
        payload: {
          recordingId,
          source: result.source,
          mime: result.mime,
          width: result.width,
          height: result.height,
          frameRate: result.frameRate,
          audio: result.audio
        }
      });
    } catch (error) {
      ingestScreenRecordingError(runtime, recording, error, "start");
      runtime.screenRecording = null;
      throw error;
    }
  }

  async function stopScreenRecording(runtime: SessionRuntime, reason: string): Promise<void> {
    const recording = runtime.screenRecording;

    if (!recording) {
      return;
    }

    if (recording.stopPromise) {
      await recording.stopPromise;
      return;
    }

    recording.stopPromise = (async () => {
      const result = await deps.getOffscreenClient().request({
        op: "stopScreenRecording",
        sid: runtime.sid,
        recordingId: recording.recordingId,
        reason
      });
      await finalizeScreenRecording(runtime, result);
    })();

    await recording.stopPromise;
  }

  /** The offscreen document has already stored the chunk; the worker records where it is. */
  function handleOffscreenScreenRecordingChunk(message: ScreenRecordingChunkMessage): void {
    const runtime = deps.getRuntimeBySid(message.sid);
    const recording = runtime?.screenRecording;

    if (!runtime || !recording || recording.recordingId !== message.recordingId) {
      return;
    }

    const { chunkId, index, mime, size } = message;
    recording.chunks[index] = chunkId;
    recording.chunkCount = Math.max(recording.chunkCount, index + 1);
    recording.sizeBytes += size;

    deps.ingestRawEvent({
      source: "system",
      rawType: "screen.recording.chunk",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        recordingId: recording.recordingId,
        chunkId,
        index,
        mime,
        size,
        startOffsetMs: message.startOffsetMs,
        endOffsetMs: message.endOffsetMs,
        durationMs: message.durationMs
      }
    });
  }

  async function handleOffscreenScreenRecordingEnded(
    message: ScreenRecordingEndedMessage
  ): Promise<void> {
    const runtime = deps.getRuntimeBySid(message.sid);

    if (!runtime?.screenRecording) {
      return;
    }

    await finalizeScreenRecording(runtime, message.result);
  }

  function handleOffscreenScreenRecordingError(message: ScreenRecordingErrorMessage): void {
    const runtime = deps.getRuntimeBySid(message.sid);
    const recording = runtime?.screenRecording;

    if (!runtime) {
      return;
    }

    deps.ingestRawEvent({
      source: "system",
      rawType: "screen.recording.error",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        recordingId: message.recordingId ?? recording?.recordingId,
        name: message.name,
        message: message.message,
        stage: message.stage
      }
    });
  }

  async function finalizeScreenRecording(
    runtime: SessionRuntime,
    result: ScreenRecordingStopResult
  ): Promise<void> {
    const recording = runtime.screenRecording;

    if (!recording || recording.recordingId !== result.recordingId) {
      return;
    }

    const chunks = recording.chunks.filter(
      (chunk): chunk is string => typeof chunk === "string" && chunk.length > 0
    );

    deps.ingestRawEvent({
      source: "system",
      rawType: "screen.recording.end",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        recordingId: recording.recordingId,
        mime: result.mime || recording.mime,
        chunks,
        chunkCount: chunks.length,
        size: recording.sizeBytes,
        durationMs: Math.max(0, Math.round(result.durationMs)),
        width: result.width ?? recording.width,
        height: result.height ?? recording.height,
        reason: result.reason
      }
    });

    runtime.screenRecording = null;
  }

  function ingestScreenRecordingError(
    runtime: SessionRuntime,
    recording: ScreenRecordingRuntime | null,
    error: unknown,
    stage: string
  ): void {
    deps.ingestRawEvent({
      source: "system",
      rawType: "screen.recording.error",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        recordingId: recording?.recordingId,
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        stage
      }
    });
  }

  return {
    shouldStartScreenRecording,
    startScreenRecording,
    stopScreenRecording,
    handleOffscreenScreenRecordingChunk,
    handleOffscreenScreenRecordingEnded,
    handleOffscreenScreenRecordingError
  };
}

export function createScreenRecordingId(sid: string): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `VR-${sid}-${Date.now()}-${random}`;
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}
