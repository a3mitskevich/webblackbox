import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { OffscreenClient } from "./offscreen-client.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createOffscreenSessionRecovery } from "./offscreen-recovery.js";
import {
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";

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

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function createHarness(runtime: SessionRuntime | undefined) {
  const requestOnce = vi.fn<(request: unknown) => Promise<unknown>>(async () => undefined);
  const notifyOffscreenPipelineStatus = vi.fn();
  const runtimes = new Map<string, SessionRuntime>();

  if (runtime) {
    runtimes.set(runtime.sid, runtime);
  }

  const recovery = createOffscreenSessionRecovery({
    getRuntimeBySid: (sid) => runtimes.get(sid),
    tabRuntimes: () => runtimes.values(),
    offscreenClient: { requestOnce } as unknown as Pick<OffscreenClient, "requestOnce">,
    notifyOffscreenPipelineStatus
  });

  return { recovery, requestOnce, notifyOffscreenPipelineStatus, runtimes };
}

describe("createOffscreenSessionRecovery", () => {
  it("restarts the session pipeline and notifies the status change", async () => {
    const runtime = createRuntime();
    const { recovery, requestOnce, notifyOffscreenPipelineStatus } = createHarness(runtime);

    await recovery.recoverOffscreenSession(runtime.sid);

    expect(requestOnce).toHaveBeenCalledTimes(1);
    expect(requestOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "start",
        sid: runtime.sid,
        redactionProfile: runtime.config.redaction,
        capturePolicy: runtime.config.capturePolicy
      })
    );
    expect(notifyOffscreenPipelineStatus).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight recovery between concurrent callers", async () => {
    const runtime = createRuntime();
    const { recovery, requestOnce } = createHarness(runtime);
    const gate = deferred();

    requestOnce.mockImplementationOnce(() => gate.promise);

    const first = recovery.recoverOffscreenSession(runtime.sid);
    const second = recovery.recoverOffscreenSession(runtime.sid);

    gate.resolve(undefined);
    await Promise.all([first, second]);

    expect(requestOnce).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed recovery", async () => {
    const runtime = createRuntime();
    const { recovery, requestOnce } = createHarness(runtime);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    requestOnce.mockRejectedValueOnce(new Error("port gone"));

    await expect(recovery.recoverOffscreenSession(runtime.sid)).rejects.toThrow("port gone");
    await recovery.recoverOffscreenSession(runtime.sid);

    expect(requestOnce).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });

  it("skips sessions that are gone, stopping, or stopped", async () => {
    const { recovery, requestOnce, runtimes } = createHarness(undefined);

    await recovery.recoverOffscreenSession("missing");

    const stopping = createRuntime({ sid: "S-2" });
    stopping.stopping = true;
    runtimes.set(stopping.sid, stopping);

    const stopped = createRuntime({ sid: "S-3", stoppedAt: 2_000 });
    runtimes.set(stopped.sid, stopped);

    await recovery.recoverOffscreenSession(stopping.sid);
    await recovery.recoverOffscreenSession(stopped.sid);

    expect(requestOnce).not.toHaveBeenCalled();
  });

  it("recovers every active tab session, skipping the finished ones", async () => {
    const active = createRuntime({ sid: "S-1" });
    const { recovery, requestOnce, runtimes } = createHarness(active);

    const stopping = createRuntime({ sid: "S-2", tabId: 8 });
    stopping.stopping = true;
    runtimes.set(stopping.sid, stopping);

    const stopped = createRuntime({ sid: "S-3", tabId: 9, stoppedAt: 2_000 });
    runtimes.set(stopped.sid, stopped);

    await recovery.recoverAllActiveOffscreenPipelines();

    expect(requestOnce).toHaveBeenCalledTimes(1);
    expect(requestOnce).toHaveBeenCalledWith(expect.objectContaining({ sid: active.sid }));
  });
});
