import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";
import {
  createStopDrainTracker,
  shouldAllowStopDrainContentEvent,
  STOP_DRAIN_ACK_TIMEOUT_MS,
  STOP_DRAIN_CONTENT_RAW_TYPES
} from "./stop-drain.js";

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

function createContentEvent(rawType: string, sid = "S-1") {
  return {
    source: "content" as const,
    rawType,
    sid,
    tabId: 7,
    t: 1_000,
    mono: 1_000,
    payload: {}
  };
}

describe("shouldAllowStopDrainContentEvent", () => {
  it("allows stop-drain snapshot kinds from the same session before the drain finished", () => {
    const runtime = createRuntime();

    for (const rawType of STOP_DRAIN_CONTENT_RAW_TYPES) {
      expect(shouldAllowStopDrainContentEvent(runtime, createContentEvent(rawType))).toBe(true);
    }
  });

  it("rejects non-snapshot kinds even while the drain runs", () => {
    const runtime = createRuntime();

    expect(shouldAllowStopDrainContentEvent(runtime, createContentEvent("mousemove"))).toBe(false);
    expect(shouldAllowStopDrainContentEvent(runtime, createContentEvent("console"))).toBe(false);
  });

  it("rejects events from another session or another source", () => {
    const runtime = createRuntime();

    expect(shouldAllowStopDrainContentEvent(runtime, createContentEvent("snapshot", "S-2"))).toBe(
      false
    );
    expect(
      shouldAllowStopDrainContentEvent(runtime, {
        ...createContentEvent("snapshot"),
        source: "cdp" as const
      })
    ).toBe(false);
  });

  it("rejects everything once the session is stop-drained", () => {
    const runtime = createRuntime();
    runtime.stopDrained = true;

    expect(shouldAllowStopDrainContentEvent(runtime, createContentEvent("snapshot"))).toBe(false);
  });
});

describe("createStopDrainTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks in-flight content batches per tab and floors at zero", () => {
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => undefined });

    tracker.adjustInFlightContentMessages(7, 1);
    tracker.adjustInFlightContentMessages(7, 1);
    expect(tracker.inFlightContentMessages(7)).toBe(2);

    tracker.adjustInFlightContentMessages(7, -1);
    expect(tracker.inFlightContentMessages(7)).toBe(1);

    tracker.adjustInFlightContentMessages(7, -1);
    expect(tracker.inFlightContentMessages(7)).toBe(0);

    tracker.adjustInFlightContentMessages(7, -1);
    expect(tracker.inFlightContentMessages(7)).toBe(0);
    expect(tracker.inFlightContentMessages(8)).toBe(0);
  });

  it("resolves the ack once the content script acked and no batch is in flight", async () => {
    const runtime = createRuntime();
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => runtime });

    const ack = tracker.createStopDrainAck(runtime);
    tracker.markStopDrainAckReceived(runtime.sid);

    await expect(ack).resolves.toBeUndefined();
    expect(tracker.pendingStopDrainAckCount()).toBe(0);
  });

  it("holds the ack while a content batch is in flight, then resolves when it drains", async () => {
    const runtime = createRuntime();
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => runtime });

    const ack = tracker.createStopDrainAck(runtime);
    let resolved = false;
    void ack.then(() => {
      resolved = true;
    });

    tracker.adjustInFlightContentMessages(runtime.tabId, 1);
    tracker.markStopDrainAckReceived(runtime.sid);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(tracker.pendingStopDrainAckCount()).toBe(1);

    tracker.adjustInFlightContentMessages(runtime.tabId, -1);
    await expect(ack).resolves.toBeUndefined();
    expect(resolved).toBe(true);
    expect(tracker.pendingStopDrainAckCount()).toBe(0);
  });

  it("waits for the session queue to drain after the ack", async () => {
    const runtime = createRuntime();
    let releaseQueue: () => void = () => undefined;
    runtime.queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => runtime });

    const ack = tracker.createStopDrainAck(runtime);
    let resolved = false;
    void ack.then(() => {
      resolved = true;
    });

    tracker.markStopDrainAckReceived(runtime.sid);
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseQueue();
    await expect(ack).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("resolves anyway after the ack timeout", async () => {
    const runtime = createRuntime();
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => runtime });

    const ack = tracker.createStopDrainAck(runtime);
    expect(tracker.pendingStopDrainAckCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(STOP_DRAIN_ACK_TIMEOUT_MS);
    await expect(ack).resolves.toBeUndefined();
    expect(tracker.pendingStopDrainAckCount()).toBe(0);
  });

  it("a late ack after the timeout is a no-op", async () => {
    const runtime = createRuntime();
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => runtime });

    const ack = tracker.createStopDrainAck(runtime);
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_ACK_TIMEOUT_MS);
    await expect(ack).resolves.toBeUndefined();

    tracker.markStopDrainAckReceived(runtime.sid);
    expect(tracker.pendingStopDrainAckCount()).toBe(0);
  });

  it("an ack for an unknown sid is ignored", () => {
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => undefined });

    tracker.markStopDrainAckReceived("S-missing");
    expect(tracker.pendingStopDrainAckCount()).toBe(0);
  });

  it("recreating the ack for a session replaces the pending one", async () => {
    const runtime = createRuntime();
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => undefined });

    void tracker.createStopDrainAck(runtime);
    const second = tracker.createStopDrainAck(runtime);
    expect(tracker.pendingStopDrainAckCount()).toBe(1);

    tracker.markStopDrainAckReceived(runtime.sid);
    await expect(second).resolves.toBeUndefined();
  });

  it("only resolves acks of the tab whose batches drained", async () => {
    const first = createRuntime({ sid: "S-1", tabId: 7 });
    const second = createRuntime({ sid: "S-2", tabId: 9 });
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => undefined });

    const firstAck = tracker.createStopDrainAck(first);
    const secondAck = tracker.createStopDrainAck(second);
    let firstResolved = false;
    let secondResolved = false;
    void firstAck.then(() => {
      firstResolved = true;
    });
    void secondAck.then(() => {
      secondResolved = true;
    });

    tracker.adjustInFlightContentMessages(7, 1);
    tracker.adjustInFlightContentMessages(9, 1);
    tracker.markStopDrainAckReceived("S-1");
    tracker.markStopDrainAckReceived("S-2");
    tracker.adjustInFlightContentMessages(7, -1);

    await expect(firstAck).resolves.toBeUndefined();
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);
    expect(tracker.pendingStopDrainAckCount()).toBe(1);

    tracker.adjustInFlightContentMessages(9, -1);
    await expect(secondAck).resolves.toBeUndefined();
  });

  it("resolves immediately when the session is already gone", async () => {
    const runtime = createRuntime();
    const tracker = createStopDrainTracker({ getRuntimeBySid: () => undefined });

    const ack = tracker.createStopDrainAck(runtime);
    tracker.markStopDrainAckReceived(runtime.sid);

    await expect(ack).resolves.toBeUndefined();
  });
});
