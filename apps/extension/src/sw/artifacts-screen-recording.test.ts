import { DEFAULT_CAPTURE_POLICY, DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it } from "vitest";

import type {
  OffscreenPipelineOp,
  OffscreenPipelineRequestFor,
  OffscreenPipelineResults,
  ScreenRecordingChunkMessage,
  ScreenRecordingEndedMessage,
  ScreenRecordingErrorMessage,
  ScreenRecordingStartResult,
  ScreenRecordingStopResult
} from "../shared/offscreen-messages.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  createScreenRecordingController,
  createScreenRecordingId,
  type ScreenRecordingController
} from "./artifacts-screen-recording.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { OffscreenClient, SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const SID = "S-1";
const TAB_ID = 7;

const START_RESULT: ScreenRecordingStartResult = {
  recordingId: "",
  source: "tab",
  mime: "video/webm;codecs=vp9",
  width: 1280,
  height: 720,
  frameRate: 30,
  audio: false
};

type RecordedRequest = { op: string; recordingId?: string; streamId?: string; reason?: string };

function createOffscreenStub(options: {
  startResult?: ScreenRecordingStartResult;
  startError?: Error;
}): {
  client: OffscreenClient;
  requests: RecordedRequest[];
  setStopResult: (result: ScreenRecordingStopResult) => void;
} {
  const requests: RecordedRequest[] = [];
  let stopResult: ScreenRecordingStopResult | null = null;
  const request = <TOp extends OffscreenPipelineOp>(
    pipelineRequest: OffscreenPipelineRequestFor<TOp>
  ): Promise<OffscreenPipelineResults[TOp]> => {
    const recorded = pipelineRequest as RecordedRequest;
    requests.push(recorded);

    if (pipelineRequest.op === "startScreenRecording") {
      if (options.startError) {
        return Promise.reject(options.startError);
      }

      return Promise.resolve({
        ...(options.startResult ?? START_RESULT),
        recordingId: recorded.recordingId ?? ""
      } as OffscreenPipelineResults[TOp]);
    }

    if (pipelineRequest.op === "stopScreenRecording" && stopResult) {
      return Promise.resolve(stopResult as OffscreenPipelineResults[TOp]);
    }

    return Promise.reject(new Error(`unexpected op ${pipelineRequest.op}`));
  };

  return {
    client: {
      request,
      requestOnce: request,
      post: () => undefined,
      receive: () => null,
      rejectPending: () => undefined,
      pendingCount: () => 0
    },
    requests,
    setStopResult: (result) => {
      stopResult = result;
    }
  };
}

function createPipelineStub(): SessionPipelineClient {
  return {
    start: () => Promise.resolve(),
    ingest: () => Promise.resolve(),
    ingestBatch: () => Promise.resolve(0),
    flush: () => Promise.resolve(),
    putBlob: () => Promise.resolve("blob-hash"),
    exportAndDownload: () => Promise.reject(new Error("not implemented")),
    close: () => Promise.resolve()
  };
}

function recordingConfig(screenRecordings: "off" | "allow"): typeof DEFAULT_RECORDER_CONFIG {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        screenRecordings
      }
    }
  };
}

function createRuntime(overrides: {
  mode?: "lite" | "full";
  config?: typeof DEFAULT_RECORDER_CONFIG;
}): SessionRuntime {
  return createSessionRuntime(
    {
      sid: SID,
      tabId: TAB_ID,
      mode: overrides.mode ?? "full",
      profile: {
        request: "auto",
        selection: {
          profile: createDefaultProfile(),
          source: "default",
          extended: false
        },
        profileConfig: DEFAULT_RECORDER_CONFIG,
        visualsCaptured: { screenshots: true, screenRecordings: true }
      },
      url: "https://example.test/app",
      annotation: { tags: [] },
      config: overrides.config ?? recordingConfig("allow"),
      startedAt: 1_000,
      pipeline: createPipelineStub(),
      recorderPlugins: createDefaultRecorderPlugins(),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET }
    },
    {
      createFullBodyCapture: () =>
        new FullBodyCapture({
          isEnabled: () => false,
          resolveRule: () => ({ enabled: false, maxBytes: 0, mimeAllowlist: [] }),
          readResponseBody: () => Promise.resolve({ ok: false, error: "unavailable" }),
          storeBody: () => Promise.resolve(0),
          emitSkip: () => undefined
        })
    }
  );
}

function createHarness(options: {
  offscreen: { client: OffscreenClient; requests: RecordedRequest[] };
  withTabCapture?: boolean;
  streamId?: string;
  runtimes?: Map<string, SessionRuntime>;
}): {
  controller: ScreenRecordingController;
  ingested: RawRecorderEvent[];
  mediaRequests: Array<{ targetTabId?: number }>;
} {
  const ingested: RawRecorderEvent[] = [];
  const mediaRequests: Array<{ targetTabId?: number }> = [];
  const runtimes = options.runtimes ?? new Map<string, SessionRuntime>();
  const controller = createScreenRecordingController({
    tabCapture:
      options.withTabCapture === false
        ? undefined
        : {
            getMediaStreamId: (mediaOptions) => {
              mediaRequests.push(mediaOptions ?? {});
              return Promise.resolve(options.streamId ?? "stream-1");
            }
          },
    getOffscreenClient: () => options.offscreen.client,
    getRuntimeBySid: (sid) => runtimes.get(sid),
    ingestRawEvent: (event) => {
      ingested.push(event);
    }
  });

  return { controller, ingested, mediaRequests };
}

function stopResult(
  recordingId: string,
  overrides: Partial<ScreenRecordingStopResult> = {}
): ScreenRecordingStopResult {
  return {
    recordingId,
    mime: "video/webm;codecs=vp9",
    chunkCount: 1,
    size: 100,
    durationMs: 1_000,
    width: 1280,
    height: 720,
    reason: "session-stop",
    ...overrides
  };
}

describe("shouldStartScreenRecording", () => {
  it("starts only for full mode with screen recordings allowed", () => {
    const offscreen = createOffscreenStub({});
    const { controller } = createHarness({ offscreen });

    expect(controller.shouldStartScreenRecording(createRuntime({ mode: "full" }))).toBe(true);
    expect(controller.shouldStartScreenRecording(createRuntime({ mode: "lite" }))).toBe(false);
    expect(
      controller.shouldStartScreenRecording(
        createRuntime({ mode: "full", config: recordingConfig("off") })
      )
    ).toBe(false);
  });
});

describe("startScreenRecording", () => {
  it("throws when the tabCapture API is unavailable", async () => {
    const offscreen = createOffscreenStub({});
    const { controller } = createHarness({ offscreen, withTabCapture: false });
    const runtime = createRuntime({});

    await expect(controller.startScreenRecording(runtime)).rejects.toThrow(
      "Chrome tabCapture API is unavailable for screen recording."
    );
    expect(runtime.screenRecording).toBeNull();
    expect(offscreen.requests).toEqual([]);
  });

  it("requests a stream, starts the offscreen recorder and records the start", async () => {
    const offscreen = createOffscreenStub({});
    const { controller, ingested, mediaRequests } = createHarness({ offscreen });
    const runtime = createRuntime({});

    await controller.startScreenRecording(runtime);

    expect(mediaRequests).toEqual([{ targetTabId: TAB_ID }]);
    expect(offscreen.requests).toHaveLength(1);
    expect(offscreen.requests[0]?.op).toBe("startScreenRecording");
    expect(offscreen.requests[0]?.streamId).toBe("stream-1");

    const recording = runtime.screenRecording;
    expect(recording?.recordingId).toBe(offscreen.requests[0]?.recordingId);
    expect(recording?.mime).toBe("video/webm;codecs=vp9");
    expect(recording?.width).toBe(1280);
    expect(recording?.height).toBe(720);
    expect(recording?.frameRate).toBe(30);

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.rawType).toBe("screen.recording.start");
    expect(ingested[0]?.payload).toMatchObject({
      recordingId: recording?.recordingId,
      source: "tab",
      mime: "video/webm;codecs=vp9",
      width: 1280,
      height: 720,
      frameRate: 30,
      audio: false
    });
  });

  it("does not start twice for the same session", async () => {
    const offscreen = createOffscreenStub({});
    const { controller, mediaRequests } = createHarness({ offscreen });
    const runtime = createRuntime({});

    await controller.startScreenRecording(runtime);
    await controller.startScreenRecording(runtime);

    expect(mediaRequests).toHaveLength(1);
    expect(offscreen.requests).toHaveLength(1);
  });

  it("throws when Chrome grants no stream", async () => {
    const offscreen = createOffscreenStub({});
    const { controller, ingested } = createHarness({ offscreen, streamId: "" });
    const runtime = createRuntime({});

    await expect(controller.startScreenRecording(runtime)).rejects.toThrow(
      "Chrome did not grant a tab capture stream."
    );
    expect(runtime.screenRecording).toBeNull();
    expect(ingested).toEqual([]);
  });

  it("records the error and rethrows when the offscreen start fails", async () => {
    const offscreen = createOffscreenStub({ startError: new Error("offscreen gone") });
    const { controller, ingested } = createHarness({ offscreen });
    const runtime = createRuntime({});

    await expect(controller.startScreenRecording(runtime)).rejects.toThrow("offscreen gone");

    expect(runtime.screenRecording).toBeNull();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.rawType).toBe("screen.recording.error");
    expect(ingested[0]?.payload).toMatchObject({
      name: "Error",
      message: "offscreen gone",
      stage: "start"
    });
  });
});

describe("stopScreenRecording", () => {
  it("does nothing without an active recording", async () => {
    const offscreen = createOffscreenStub({});
    const { controller } = createHarness({ offscreen });
    const runtime = createRuntime({});

    await controller.stopScreenRecording(runtime, "session-stop");

    expect(offscreen.requests).toEqual([]);
  });

  it("stops the offscreen recorder, records the end and clears the runtime", async () => {
    const offscreen = createOffscreenStub({});
    const { controller, ingested } = createHarness({ offscreen });
    const runtime = createRuntime({});

    await controller.startScreenRecording(runtime);
    const recordingId = runtime.screenRecording?.recordingId ?? "";
    runtime.screenRecording?.chunks.push("chunk-0");
    if (runtime.screenRecording) {
      runtime.screenRecording.chunkCount = 1;
      runtime.screenRecording.sizeBytes = 42;
    }

    offscreen.setStopResult(stopResult(recordingId, { durationMs: 1_234.6 }));
    await controller.stopScreenRecording(runtime, "session-stop");

    expect(offscreen.requests.map(({ op }) => op)).toEqual([
      "startScreenRecording",
      "stopScreenRecording"
    ]);
    expect(offscreen.requests[1]?.recordingId).toBe(recordingId);
    expect(offscreen.requests[1]?.reason).toBe("session-stop");

    const endEvent = ingested.find(({ rawType }) => rawType === "screen.recording.end");
    expect(endEvent?.payload).toMatchObject({
      recordingId,
      mime: "video/webm;codecs=vp9",
      chunks: ["chunk-0"],
      chunkCount: 1,
      size: 42,
      durationMs: 1_235,
      width: 1280,
      height: 720,
      reason: "session-stop"
    });
    expect(runtime.screenRecording).toBeNull();
  });

  it("awaits the in-flight stop instead of stopping twice", async () => {
    const offscreen = createOffscreenStub({});
    const { controller } = createHarness({ offscreen });
    const runtime = createRuntime({});

    await controller.startScreenRecording(runtime);
    const recordingId = runtime.screenRecording?.recordingId ?? "";
    offscreen.setStopResult(stopResult(recordingId));

    await Promise.all([
      controller.stopScreenRecording(runtime, "session-stop"),
      controller.stopScreenRecording(runtime, "session-stop")
    ]);

    expect(offscreen.requests.map(({ op }) => op)).toEqual([
      "startScreenRecording",
      "stopScreenRecording"
    ]);
  });
});

describe("offscreen callbacks", () => {
  async function startRecording(
    controller: ScreenRecordingController,
    runtime: SessionRuntime
  ): Promise<string> {
    await controller.startScreenRecording(runtime);
    return runtime.screenRecording?.recordingId ?? "";
  }

  it("records chunk bookkeeping and the chunk event", async () => {
    const offscreen = createOffscreenStub({});
    const runtimes = new Map<string, SessionRuntime>();
    const { controller, ingested } = createHarness({ offscreen, runtimes });
    const runtime = createRuntime({});
    runtimes.set(SID, runtime);
    const recordingId = await startRecording(controller, runtime);

    const message: ScreenRecordingChunkMessage = {
      kind: "offscreen.screen-recording-chunk",
      sid: SID,
      recordingId,
      index: 1,
      mime: "video/webm",
      chunkId: "chunk-1",
      size: 64,
      startOffsetMs: 500,
      endOffsetMs: 1_000,
      durationMs: 500
    };
    controller.handleOffscreenScreenRecordingChunk(message);

    expect(runtime.screenRecording?.chunks[1]).toBe("chunk-1");
    expect(runtime.screenRecording?.chunkCount).toBe(2);
    expect(runtime.screenRecording?.sizeBytes).toBe(64);

    const chunkEvent = ingested.find(({ rawType }) => rawType === "screen.recording.chunk");
    expect(chunkEvent?.payload).toMatchObject({
      recordingId,
      chunkId: "chunk-1",
      index: 1,
      mime: "video/webm",
      size: 64,
      startOffsetMs: 500,
      endOffsetMs: 1_000,
      durationMs: 500
    });
  });

  it("ignores chunks for unknown sessions and other recordings", async () => {
    const offscreen = createOffscreenStub({});
    const runtimes = new Map<string, SessionRuntime>();
    const { controller, ingested } = createHarness({ offscreen, runtimes });
    const runtime = createRuntime({});
    runtimes.set(SID, runtime);
    const recordingId = await startRecording(controller, runtime);
    const chunk: ScreenRecordingChunkMessage = {
      kind: "offscreen.screen-recording-chunk",
      sid: SID,
      recordingId: "VR-other",
      index: 0,
      mime: "video/webm",
      chunkId: "chunk-0",
      size: 10,
      startOffsetMs: 0,
      endOffsetMs: 100,
      durationMs: 100
    };

    controller.handleOffscreenScreenRecordingChunk(chunk);
    controller.handleOffscreenScreenRecordingChunk({ ...chunk, sid: "S-unknown", recordingId });

    expect(runtime.screenRecording?.chunkCount).toBe(0);
    expect(ingested.filter(({ rawType }) => rawType === "screen.recording.chunk")).toEqual([]);
  });

  it("finalizes with only the stored chunks when the offscreen document ends the recording", async () => {
    const offscreen = createOffscreenStub({});
    const runtimes = new Map<string, SessionRuntime>();
    const { controller, ingested } = createHarness({ offscreen, runtimes });
    const runtime = createRuntime({});
    runtimes.set(SID, runtime);
    const recordingId = await startRecording(controller, runtime);

    controller.handleOffscreenScreenRecordingChunk({
      kind: "offscreen.screen-recording-chunk",
      sid: SID,
      recordingId,
      index: 2,
      mime: "video/webm",
      chunkId: "chunk-2",
      size: 30,
      startOffsetMs: 1_000,
      endOffsetMs: 1_500,
      durationMs: 500
    });

    const message: ScreenRecordingEndedMessage = {
      kind: "offscreen.screen-recording-ended",
      sid: SID,
      result: stopResult(recordingId, { durationMs: -5, mime: "", width: undefined })
    };
    await controller.handleOffscreenScreenRecordingEnded(message);

    const endEvent = ingested.find(({ rawType }) => rawType === "screen.recording.end");
    expect(endEvent?.payload).toMatchObject({
      recordingId,
      mime: "video/webm;codecs=vp9",
      chunks: ["chunk-2"],
      chunkCount: 1,
      size: 30,
      durationMs: 0,
      height: 720
    });
    expect(runtime.screenRecording).toBeNull();
  });

  it("ignores the ended notice without an active recording", async () => {
    const offscreen = createOffscreenStub({});
    const runtimes = new Map<string, SessionRuntime>();
    const { controller, ingested } = createHarness({ offscreen, runtimes });
    const runtime = createRuntime({});
    runtimes.set(SID, runtime);

    await controller.handleOffscreenScreenRecordingEnded({
      kind: "offscreen.screen-recording-ended",
      sid: SID,
      result: stopResult("VR-none")
    });

    expect(ingested).toEqual([]);
  });

  it("records offscreen recorder errors with the active recording id", async () => {
    const offscreen = createOffscreenStub({});
    const runtimes = new Map<string, SessionRuntime>();
    const { controller, ingested } = createHarness({ offscreen, runtimes });
    const runtime = createRuntime({});
    runtimes.set(SID, runtime);
    const recordingId = await startRecording(controller, runtime);

    const message: ScreenRecordingErrorMessage = {
      kind: "offscreen.screen-recording-error",
      sid: SID,
      name: "NotAllowedError",
      message: "track ended",
      stage: "record"
    };
    controller.handleOffscreenScreenRecordingError(message);

    const errorEvent = ingested.find(({ rawType }) => rawType === "screen.recording.error");
    expect(errorEvent?.payload).toMatchObject({
      recordingId,
      name: "NotAllowedError",
      message: "track ended",
      stage: "record"
    });
  });

  it("ignores recorder errors for unknown sessions", async () => {
    const offscreen = createOffscreenStub({});
    const { controller, ingested } = createHarness({ offscreen });

    controller.handleOffscreenScreenRecordingError({
      kind: "offscreen.screen-recording-error",
      sid: "S-unknown",
      message: "boom"
    });

    expect(ingested).toEqual([]);
  });
});

describe("createScreenRecordingId", () => {
  it("builds a VR id scoped to the session", () => {
    const id = createScreenRecordingId(SID);

    expect(id.startsWith(`VR-${SID}-`)).toBe(true);
    expect(createScreenRecordingId(SID)).not.toBe(id);
  });
});
