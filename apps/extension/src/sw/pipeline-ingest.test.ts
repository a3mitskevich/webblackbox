import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import type { ScreenshotArtifactsController } from "./artifacts-screenshot.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { FullCdpController } from "./full-cdp.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createPipelineIngest, type PipelineIngestDeps } from "./pipeline-ingest.js";
import { createSessionQueue } from "./session-queue.js";
import {
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";
import { SCRIPT_RAW_TYPE } from "./source-maps.js";

function createPipelineStub(): SessionPipelineClient {
  return {
    start: vi.fn(async () => undefined),
    ingest: vi.fn(async () => undefined),
    ingestBatch: vi.fn(async () => 0),
    flush: vi.fn(async () => undefined),
    putBlob: vi.fn(async () => "blob-id"),
    exportAndDownload: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    close: vi.fn(async () => undefined)
  };
}

function createFullBodyCaptureStub(): FullBodyCapture {
  return new FullBodyCapture({
    isEnabled: () => false,
    resolveRule: () => ({ enabled: false, maxBytes: 0, mimeAllowlist: [] }),
    readResponseBody: () => Promise.resolve({ ok: false, error: "unavailable" }),
    storeBody: () => Promise.resolve(0),
    emitSkip: () => undefined
  });
}

function createRuntime(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntime {
  return createSessionRuntime(
    {
      sid: "S-1",
      tabId: 7,
      mode: "lite",
      profile: {
        request: "auto",
        selection: { profile: createDefaultProfile(), source: "default", extended: false },
        profileConfig: DEFAULT_RECORDER_CONFIG,
        visualsCaptured: { screenshots: true, screenRecordings: false }
      },
      url: "https://example.test/app",
      title: "Example",
      annotation: { tags: [] },
      config: DEFAULT_RECORDER_CONFIG,
      startedAt: 1_000,
      pipeline: createPipelineStub(),
      recorderPlugins: createDefaultRecorderPlugins(),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET },
      ...overrides
    },
    { createFullBodyCapture: () => createFullBodyCaptureStub() }
  );
}

function createContentEvent(rawType: string, payload: unknown = {}): RawRecorderEvent {
  return {
    source: "content",
    rawType,
    sid: "S-1",
    tabId: 7,
    t: 1_000,
    mono: 1_000,
    payload
  } as RawRecorderEvent;
}

type Harness = {
  ingestRawEvent: ReturnType<typeof createPipelineIngest>["ingestRawEvent"];
  recordScriptSourceMap: ReturnType<typeof vi.fn>;
  shouldCaptureActionScreenshot: ReturnType<typeof vi.fn>;
  captureScreenshot: ReturnType<typeof vi.fn>;
  runtime: SessionRuntime;
};

function createHarness(runtime: SessionRuntime): Harness {
  const recordScriptSourceMap = vi.fn();
  const shouldCaptureActionScreenshot = vi.fn(() => false);
  const captureScreenshot = vi.fn(async () => undefined);
  const { enqueue } = createSessionQueue({
    bestEffortQueueMaxPending: 10,
    shouldLogPerf: () => false
  });
  const deps: PipelineIngestDeps = {
    byTab: new Map([[runtime.tabId, runtime]]),
    bySid: new Map([[runtime.sid, runtime]]),
    enqueue,
    getFullCdp: () =>
      ({ recordScriptSourceMap }) as unknown as Pick<FullCdpController, "recordScriptSourceMap">,
    getScreenshotArtifacts: () =>
      ({ shouldCaptureActionScreenshot, captureScreenshot }) as unknown as Pick<
        ScreenshotArtifactsController,
        "shouldCaptureActionScreenshot" | "captureScreenshot"
      >
  };
  const { ingestRawEvent } = createPipelineIngest(deps);

  return {
    ingestRawEvent,
    recordScriptSourceMap,
    shouldCaptureActionScreenshot,
    captureScreenshot,
    runtime
  };
}

describe("createPipelineIngest", () => {
  it("drops events that belong to no known session", () => {
    const runtime = createRuntime();
    const { ingestRawEvent } = createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    ingestRawEvent(createContentEvent("click", { x: 1, y: 2 }), {});
    ingestRawEvent({ ...createContentEvent("click"), tabId: 999, sid: "nope" });

    // Only the first event resolves to the session.
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("stamps the session sid and ingests a plain content event", () => {
    const runtime = createRuntime();
    const { ingestRawEvent } = createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    ingestRawEvent({ ...createContentEvent("scroll"), sid: "wrong-sid" });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({ rawType: "scroll", sid: runtime.sid });
  });

  it("drops content events of a stopping session unless they arrived before the stop", () => {
    const runtime = createRuntime();
    runtime.stopping = true;
    const { ingestRawEvent } = createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    ingestRawEvent(createContentEvent("click", { x: 1, y: 2 }));
    expect(ingest).not.toHaveBeenCalled();

    ingestRawEvent(createContentEvent("click", { x: 1, y: 2 }), { arrivedBeforeStop: true });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("still accepts system events while the session is stopping", () => {
    const runtime = createRuntime();
    runtime.stopping = true;
    const { ingestRawEvent } = createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    ingestRawEvent({ ...createContentEvent("marker"), source: "system" });

    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("routes script payloads to source-map recording instead of the recorder", () => {
    const runtime = createRuntime();
    const { ingestRawEvent, recordScriptSourceMap } = createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    ingestRawEvent(createContentEvent(SCRIPT_RAW_TYPE, { nope: true }));

    expect(recordScriptSourceMap).toHaveBeenCalledTimes(1);
    expect(recordScriptSourceMap).toHaveBeenCalledWith(runtime, null);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("materializes lite storage snapshots through the session queue", async () => {
    const runtime = createRuntime();
    const { ingestRawEvent } = createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    ingestRawEvent(
      createContentEvent("localStorageSnapshot", {
        origin: "https://example.test",
        entries: [{ key: "k", value: "v" }]
      })
    );

    // The materialized event lands after the queued task ran.
    await runtime.queue;

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({
      rawType: "localStorageSnapshot",
      sid: runtime.sid
    });
  });

  it("captures a best-effort action screenshot in full mode", async () => {
    const runtime = createRuntime({ mode: "full" });
    const { ingestRawEvent, shouldCaptureActionScreenshot, captureScreenshot } =
      createHarness(runtime);
    const ingest = vi.spyOn(runtime.recorder, "ingest");

    shouldCaptureActionScreenshot.mockReturnValue(true);
    ingestRawEvent(createContentEvent("click", { x: 1, y: 2 }));
    await runtime.queue;

    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    expect(captureScreenshot).toHaveBeenCalledWith(runtime, "action:click");
    expect(runtime.lastActionScreenshotMono).toBe(1_000);
    // The event itself is still ingested.
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("tracks the pointer position from content events", () => {
    const runtime = createRuntime();
    const { ingestRawEvent } = createHarness(runtime);

    ingestRawEvent(createContentEvent("mousemove", { x: 10.123, y: 20.456 }));

    expect(runtime.lastPointer).toEqual({ x: 10.12, y: 20.46, t: 1_000, mono: 1_000 });
  });

  it("tracks the viewport from resize events and keeps it on invalid sizes", () => {
    const runtime = createRuntime();
    const { ingestRawEvent } = createHarness(runtime);

    ingestRawEvent(createContentEvent("resize", { width: 1280.4, height: 720.2, dpr: 2 }));

    expect(runtime.lastViewport).toEqual({ width: 1280, height: 720, dpr: 2 });

    ingestRawEvent(createContentEvent("resize", { width: 0, height: -5 }));

    expect(runtime.lastViewport).toEqual({ width: 1280, height: 720, dpr: 2 });
  });
});
