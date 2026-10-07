import type { RawRecorderEvent } from "@webblackbox/recorder";

import { sendCdpCommand, sendCdpCommandOutcome } from "./artifacts-cdp.js";
import type { SessionRuntime } from "./session-registry.js";

const CDP_HEAP_SNAPSHOT_TIMEOUT_MS = 8_000;
export const CPU_PROFILE_SAMPLE_MS = 350;

/**
 * What the trace/CPU/heap captures need from the service worker: raw-event ingestion and the
 * shared timer (the CPU profile samples for a fixed wall-clock window).
 */
export type ProfileArtifactsDeps = {
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  wait: (durationMs: number) => Promise<void>;
};

export type ProfileArtifactsController = {
  captureTraceMetrics: (runtime: SessionRuntime, reason: string) => Promise<void>;
  captureAdvancedProfiles: (runtime: SessionRuntime, reason: string) => Promise<void>;
  captureCpuProfile: (runtime: SessionRuntime, reason: string) => Promise<void>;
  captureHeapSnapshot: (runtime: SessionRuntime, reason: string) => Promise<void>;
};

export function createProfileArtifactsController(
  deps: ProfileArtifactsDeps
): ProfileArtifactsController {
  async function captureTraceMetrics(runtime: SessionRuntime, reason: string): Promise<void> {
    if (!runtime.cdpRouter) {
      return;
    }

    if (runtime.config.capturePolicy?.categories.cdp !== "full") {
      return;
    }

    const metrics = await sendCdpCommand<Record<string, unknown>>(
      runtime,
      { tabId: runtime.tabId },
      "Performance.getMetrics"
    );

    if (!metrics) {
      return;
    }

    const bytes = new TextEncoder().encode(JSON.stringify(metrics));
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    deps.ingestRawEvent({
      source: "system",
      rawType: "cdp.perf.trace",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        traceHash: hash,
        durationMs: 0,
        mode: "reportEvents",
        categories: "metrics",
        reason
      }
    });
  }

  async function captureAdvancedProfiles(runtime: SessionRuntime, reason: string): Promise<void> {
    await Promise.allSettled([
      captureCpuProfile(runtime, reason),
      captureHeapSnapshot(runtime, reason)
    ]);
  }

  async function captureCpuProfile(runtime: SessionRuntime, reason: string): Promise<void> {
    if (!runtime.cdpRouter) {
      return;
    }

    if (runtime.config.capturePolicy?.categories.cdp !== "full") {
      return;
    }

    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "Profiler.enable");

    try {
      const started = await sendCdpCommandOutcome(
        runtime,
        { tabId: runtime.tabId },
        "Profiler.start"
      );

      if (!started.ok) {
        return;
      }

      await deps.wait(CPU_PROFILE_SAMPLE_MS);

      const profileResult = await sendCdpCommand<{ profile?: unknown }>(
        runtime,
        { tabId: runtime.tabId },
        "Profiler.stop"
      );

      if (!profileResult?.profile) {
        return;
      }

      const bytes = new TextEncoder().encode(JSON.stringify(profileResult.profile));
      const hash = await runtime.pipeline.putBlob("application/json", bytes);

      deps.ingestRawEvent({
        source: "system",
        rawType: "cdp.perf.cpu.profile",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          profileHash: hash,
          sampleMs: CPU_PROFILE_SAMPLE_MS,
          size: bytes.byteLength,
          reason
        }
      });
    } finally {
      await sendCdpCommand(runtime, { tabId: runtime.tabId }, "Profiler.disable");
    }
  }

  async function captureHeapSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
    if (!runtime.cdpRouter) {
      return;
    }

    if (
      runtime.config.capturePolicy?.mode !== "lab" ||
      runtime.config.capturePolicy.categories.heapProfiles !== "lab-only"
    ) {
      return;
    }

    runtime.heapSnapshotCapture = {
      chunks: [],
      bytes: 0,
      truncated: false
    };

    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.enable");

    const completed = await sendCdpCommandOutcome(
      runtime,
      { tabId: runtime.tabId },
      "HeapProfiler.takeHeapSnapshot",
      {
        reportProgress: false,
        captureNumericValue: true
      },
      CDP_HEAP_SNAPSHOT_TIMEOUT_MS
    );

    const snapshot = runtime.heapSnapshotCapture;
    runtime.heapSnapshotCapture = null;

    if (!completed.ok || !snapshot || snapshot.chunks.length === 0) {
      await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
      return;
    }

    const joined = snapshot.chunks.join("");
    const bytes = new TextEncoder().encode(joined);
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    deps.ingestRawEvent({
      source: "system",
      rawType: "cdp.perf.heap.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        snapshotHash: hash,
        size: bytes.byteLength,
        chunkCount: snapshot.chunks.length,
        truncated: snapshot.truncated,
        reason
      }
    });

    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
  }

  return {
    captureTraceMetrics,
    captureAdvancedProfiles,
    captureCpuProfile,
    captureHeapSnapshot
  };
}

export function shouldCaptureAdvancedProfiles(reason: string): boolean {
  return reason === "manual";
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}
