import type { CdpRouter, Debuggee } from "@webblackbox/cdp-router";
import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_RECORDER_CONFIG,
  type CapturePolicy
} from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import {
  CPU_PROFILE_SAMPLE_MS,
  createProfileArtifactsController,
  shouldCaptureAdvancedProfiles,
  type ProfileArtifactsController
} from "./artifacts-profiles.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";

const SID = "S-1";
const TAB_ID = 7;

type SentCommand = {
  target: Debuggee;
  method: string;
  params?: Record<string, unknown>;
};

function createFakeRouter(options: {
  sendResult?: (method: string) => unknown;
  sendError?: (method: string) => string | null;
  onSend?: (method: string) => void;
  hangMethods?: string[];
}): { router: CdpRouter; sent: SentCommand[] } {
  const sent: SentCommand[] = [];
  const router: CdpRouter = {
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    send: <TResult>(target: Debuggee, method: string, params?: Record<string, unknown>) => {
      sent.push({ target, method, params });
      options.onSend?.(method);

      if (options.hangMethods?.includes(method)) {
        return new Promise<TResult>(() => undefined);
      }

      const error = options.sendError?.(method);

      return error
        ? Promise.reject(new Error(error))
        : Promise.resolve(options.sendResult?.(method) as TResult);
    },
    enableBaseline: () => Promise.resolve(),
    enableAutoAttach: () => Promise.resolve(),
    getAttachedTargets: () => [],
    onEvent: () => () => undefined,
    onDetach: () => () => undefined,
    dispose: () => undefined
  };

  return { router, sent };
}

function createPipelineStub(overrides: Partial<SessionPipelineClient> = {}): SessionPipelineClient {
  return {
    start: () => Promise.resolve(),
    ingest: () => Promise.resolve(),
    ingestBatch: () => Promise.resolve(0),
    flush: () => Promise.resolve(),
    putBlob: () => Promise.resolve("blob-hash"),
    exportAndDownload: () => Promise.reject(new Error("not implemented")),
    close: () => Promise.resolve(),
    ...overrides
  };
}

function configWith(
  categories: Partial<CapturePolicy["categories"]>,
  mode?: CapturePolicy["mode"]
): typeof DEFAULT_RECORDER_CONFIG {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      mode: mode ?? DEFAULT_CAPTURE_POLICY.mode,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        ...categories
      }
    }
  };
}

function createRuntime(
  overrides: { config?: typeof DEFAULT_RECORDER_CONFIG } = {}
): SessionRuntime {
  return createSessionRuntime(
    {
      sid: SID,
      tabId: TAB_ID,
      mode: "full",
      profile: {
        request: "auto",
        selection: {
          profile: createDefaultProfile(),
          source: "default",
          extended: false
        },
        profileConfig: DEFAULT_RECORDER_CONFIG,
        visualsCaptured: { screenshots: true, screenRecordings: false }
      },
      url: "https://example.test/app",
      annotation: { tags: [] },
      config: overrides.config ?? DEFAULT_RECORDER_CONFIG,
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

function createHarness(options: { wait?: (durationMs: number) => Promise<void> } = {}): {
  controller: ProfileArtifactsController;
  ingested: RawRecorderEvent[];
  waitDurations: number[];
} {
  const ingested: RawRecorderEvent[] = [];
  const waitDurations: number[] = [];
  const controller = createProfileArtifactsController({
    ingestRawEvent: (event) => {
      ingested.push(event);
    },
    wait:
      options.wait ??
      ((durationMs) => {
        waitDurations.push(durationMs);
        return Promise.resolve();
      })
  });

  return { controller, ingested, waitDurations };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("shouldCaptureAdvancedProfiles", () => {
  it("runs the advanced profiles only for a manual reason", () => {
    expect(shouldCaptureAdvancedProfiles("manual")).toBe(true);
    expect(shouldCaptureAdvancedProfiles("session-start")).toBe(false);
    expect(shouldCaptureAdvancedProfiles("interval")).toBe(false);
    expect(shouldCaptureAdvancedProfiles("action:click")).toBe(false);
  });
});

describe("captureTraceMetrics", () => {
  it("skips sessions without full CDP capture", async () => {
    const { router, sent } = createFakeRouter({});
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "safe-subset" }) });
    runtime.cdpRouter = router;

    await controller.captureTraceMetrics(runtime, "manual");

    expect(sent).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it("stores the metrics blob and records the trace event", async () => {
    const metrics = { metrics: [{ name: "Nodes", value: 42 }] };
    const { router, sent } = createFakeRouter({
      sendResult: (method) => (method === "Performance.getMetrics" ? metrics : undefined)
    });
    const blobs: Array<{ mime: string; bytes: Uint8Array }> = [];
    const putBlob = (mime: string, bytes: Uint8Array): Promise<string> => {
      blobs.push({ mime, bytes });
      return Promise.resolve("trace-hash");
    };
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "full" }) });
    runtime.cdpRouter = router;
    runtime.pipeline = createPipelineStub({ putBlob });

    await controller.captureTraceMetrics(runtime, "manual");

    expect(sent.map(({ method }) => method)).toEqual(["Performance.getMetrics"]);

    const blob = blobs[0] as { mime: string; bytes: Uint8Array };
    expect(blob.mime).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(blob.bytes))).toEqual(metrics);

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.rawType).toBe("cdp.perf.trace");
    expect(ingested[0]?.payload).toMatchObject({
      traceHash: "trace-hash",
      durationMs: 0,
      mode: "reportEvents",
      categories: "metrics",
      reason: "manual"
    });
  });

  it("records nothing when the metrics read fails", async () => {
    const { router } = createFakeRouter({ sendError: () => "cdp gone" });
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "full" }) });
    runtime.cdpRouter = router;

    await controller.captureTraceMetrics(runtime, "manual");

    expect(ingested).toEqual([]);
  });
});

describe("captureCpuProfile", () => {
  it("samples for the fixed window, then stores and records the profile", async () => {
    const profile = { nodes: [{ id: 1 }], samples: [1] };
    const { router, sent } = createFakeRouter({
      sendResult: (method) => (method === "Profiler.stop" ? { profile } : undefined)
    });
    const blobs: Array<{ mime: string; bytes: Uint8Array }> = [];
    const putBlob = (mime: string, bytes: Uint8Array): Promise<string> => {
      blobs.push({ mime, bytes });
      return Promise.resolve("cpu-hash");
    };
    const { controller, ingested, waitDurations } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "full" }) });
    runtime.cdpRouter = router;
    runtime.pipeline = createPipelineStub({ putBlob });

    await controller.captureCpuProfile(runtime, "manual");

    expect(sent.map(({ method }) => method)).toEqual([
      "Profiler.enable",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable"
    ]);
    expect(waitDurations).toEqual([CPU_PROFILE_SAMPLE_MS]);

    const blob = blobs[0] as { mime: string; bytes: Uint8Array };
    expect(blob.mime).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(blob.bytes))).toEqual(profile);

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.rawType).toBe("cdp.perf.cpu.profile");
    expect(ingested[0]?.payload).toMatchObject({
      profileHash: "cpu-hash",
      sampleMs: CPU_PROFILE_SAMPLE_MS,
      size: blob.bytes.byteLength,
      reason: "manual"
    });
  });

  it("skips sessions without full CDP capture", async () => {
    const { router, sent } = createFakeRouter({});
    const { controller } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "safe-subset" }) });
    runtime.cdpRouter = router;

    await controller.captureCpuProfile(runtime, "manual");

    expect(sent).toEqual([]);
  });

  it("still disables the profiler when the start fails", async () => {
    const { router, sent } = createFakeRouter({
      sendError: (method) => (method === "Profiler.start" ? "profiling already active" : null)
    });
    const { controller, ingested, waitDurations } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "full" }) });
    runtime.cdpRouter = router;

    await controller.captureCpuProfile(runtime, "manual");

    expect(sent.map(({ method }) => method)).toEqual([
      "Profiler.enable",
      "Profiler.start",
      "Profiler.disable"
    ]);
    expect(waitDurations).toEqual([]);
    expect(ingested).toEqual([]);
  });

  it("records nothing when the stop returns no profile", async () => {
    const { router, sent } = createFakeRouter({});
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({ config: configWith({ cdp: "full" }) });
    runtime.cdpRouter = router;

    await controller.captureCpuProfile(runtime, "manual");

    expect(sent.map(({ method }) => method)).toEqual([
      "Profiler.enable",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable"
    ]);
    expect(ingested).toEqual([]);
  });
});

describe("captureHeapSnapshot", () => {
  it("runs only for lab mode with lab-only heap profiles", async () => {
    const { router, sent } = createFakeRouter({});
    const { controller } = createHarness();
    const runtime = createRuntime({
      config: configWith({ heapProfiles: "lab-only" }, "private")
    });
    runtime.cdpRouter = router;

    await controller.captureHeapSnapshot(runtime, "manual");

    expect(sent).toEqual([]);

    const labRuntime = createRuntime({
      config: configWith({ heapProfiles: "off" }, "lab")
    });
    labRuntime.cdpRouter = router;

    await controller.captureHeapSnapshot(labRuntime, "manual");

    expect(sent).toEqual([]);
  });

  it("joins the chunks, stores the snapshot and records it", async () => {
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWith({ heapProfiles: "lab-only" }, "lab")
    });
    const blobs: Array<{ mime: string; bytes: Uint8Array }> = [];
    const putBlob = (mime: string, bytes: Uint8Array): Promise<string> => {
      blobs.push({ mime, bytes });
      return Promise.resolve("heap-hash");
    };
    runtime.pipeline = createPipelineStub({ putBlob });
    const { router, sent } = createFakeRouter({
      onSend: (method) => {
        if (method === "HeapProfiler.takeHeapSnapshot" && runtime.heapSnapshotCapture) {
          runtime.heapSnapshotCapture.chunks.push('{"a":', "1}");
          runtime.heapSnapshotCapture.truncated = true;
        }
      }
    });
    runtime.cdpRouter = router;

    await controller.captureHeapSnapshot(runtime, "manual");

    expect(sent.map(({ method }) => method)).toEqual([
      "HeapProfiler.enable",
      "HeapProfiler.takeHeapSnapshot",
      "HeapProfiler.disable"
    ]);

    const blob = blobs[0] as { mime: string; bytes: Uint8Array };
    expect(blob.mime).toBe("application/json");
    expect(new TextDecoder().decode(blob.bytes)).toBe('{"a":1}');

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.rawType).toBe("cdp.perf.heap.snapshot");
    expect(ingested[0]?.payload).toMatchObject({
      snapshotHash: "heap-hash",
      size: blob.bytes.byteLength,
      chunkCount: 2,
      truncated: true,
      reason: "manual"
    });
    expect(runtime.heapSnapshotCapture).toBeNull();
  });

  it("disables the heap profiler and records nothing when the snapshot times out", async () => {
    vi.useFakeTimers();
    const { router, sent } = createFakeRouter({
      hangMethods: ["HeapProfiler.takeHeapSnapshot"]
    });
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWith({ heapProfiles: "lab-only" }, "lab")
    });
    runtime.cdpRouter = router;

    const capture = controller.captureHeapSnapshot(runtime, "manual");
    await vi.advanceTimersByTimeAsync(8_000);
    await capture;

    expect(sent.map(({ method }) => method)).toEqual([
      "HeapProfiler.enable",
      "HeapProfiler.takeHeapSnapshot",
      "HeapProfiler.disable"
    ]);
    expect(ingested).toEqual([]);
    expect(runtime.heapSnapshotCapture).toBeNull();
  });

  it("records nothing when the snapshot completes without chunks", async () => {
    const { router, sent } = createFakeRouter({});
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWith({ heapProfiles: "lab-only" }, "lab")
    });
    runtime.cdpRouter = router;

    await controller.captureHeapSnapshot(runtime, "manual");

    expect(sent.map(({ method }) => method)).toEqual([
      "HeapProfiler.enable",
      "HeapProfiler.takeHeapSnapshot",
      "HeapProfiler.disable"
    ]);
    expect(ingested).toEqual([]);
    expect(runtime.heapSnapshotCapture).toBeNull();
  });
});

describe("captureAdvancedProfiles", () => {
  it("runs the CPU profile and heap snapshot together, tolerating failures", async () => {
    const { router, sent } = createFakeRouter({
      sendError: (method) => (method === "Profiler.start" ? "busy" : null)
    });
    const { controller, ingested } = createHarness();
    const runtime = createRuntime({
      config: configWith({ cdp: "full", heapProfiles: "lab-only" }, "lab")
    });
    runtime.cdpRouter = router;

    await controller.captureAdvancedProfiles(runtime, "manual");

    const methods = sent.map(({ method }) => method);
    expect(methods).toContain("Profiler.enable");
    expect(methods).toContain("HeapProfiler.enable");
    expect(ingested).toEqual([]);
  });
});
