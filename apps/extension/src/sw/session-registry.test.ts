import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, WebBlackboxRecorder } from "@webblackbox/recorder";
import { describe, expect, it } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionRegistry,
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeDeps,
  type SessionRuntimeInit
} from "./session-registry.js";
import { ScriptSourceMapTracker } from "./source-maps.js";

function createPipelineStub(): SessionPipelineClient {
  return {
    start: () => Promise.resolve(),
    ingest: () => Promise.resolve(),
    ingestBatch: () => Promise.resolve(0),
    flush: () => Promise.resolve(),
    putBlob: () => Promise.resolve("blob-id"),
    exportAndDownload: () => Promise.reject(new Error("not implemented")),
    close: () => Promise.resolve()
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

const defaultDeps: SessionRuntimeDeps = {
  createFullBodyCapture: () => createFullBodyCaptureStub()
};

function createInit(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntimeInit {
  return {
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
    annotation: { tags: ["tag-a"], note: "a note" },
    config: DEFAULT_RECORDER_CONFIG,
    startedAt: 1_000,
    pipeline: createPipelineStub(),
    recorderPlugins: createDefaultRecorderPlugins(),
    performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET },
    ...overrides
  };
}

function createRuntime(sid: string, tabId: number): SessionRuntime {
  return createSessionRuntime(createInit({ sid, tabId }), defaultDeps);
}

describe("createSessionRegistry", () => {
  it("starts empty and misses unknown lookups", () => {
    const registry = createSessionRegistry();

    expect(registry.tabCount()).toBe(0);
    expect(registry.sidCount()).toBe(0);
    expect(registry.getByTab(7)).toBeUndefined();
    expect(registry.getBySid("S-1")).toBeUndefined();
    expect(registry.hasSid("S-1")).toBe(false);
  });

  it("registers a session under both indexes", () => {
    const registry = createSessionRegistry();
    const runtime = createRuntime("S-1", 7);

    registry.register(runtime);

    expect(registry.getByTab(7)).toBe(runtime);
    expect(registry.getBySid("S-1")).toBe(runtime);
    expect(registry.hasSid("S-1")).toBe(true);
    expect(registry.tabCount()).toBe(1);
    expect(registry.sidCount()).toBe(1);
  });

  it("replaces the tab binding when the tab registers again, keeping the old sid binding", () => {
    const registry = createSessionRegistry();
    const first = createRuntime("S-1", 7);
    const second = createRuntime("S-2", 7);

    registry.register(first);
    registry.register(second);

    expect(registry.getByTab(7)).toBe(second);
    expect(registry.getBySid("S-1")).toBe(first);
    expect(registry.getBySid("S-2")).toBe(second);
    expect(registry.tabCount()).toBe(1);
    expect(registry.sidCount()).toBe(2);
  });

  it("registerBySid binds only the sid index (restored stopped recordings)", () => {
    const registry = createSessionRegistry();
    const runtime = createRuntime("S-1", 7);

    registry.registerBySid(runtime);

    expect(registry.getBySid("S-1")).toBe(runtime);
    expect(registry.getByTab(7)).toBeUndefined();
    expect(registry.tabCount()).toBe(0);
    expect(registry.sidCount()).toBe(1);
  });

  it("unregisterTab drops only the tab binding; the sid binding survives the stop drain", () => {
    const registry = createSessionRegistry();
    const runtime = createRuntime("S-1", 7);

    registry.register(runtime);
    registry.unregisterTab(7);

    expect(registry.getByTab(7)).toBeUndefined();
    expect(registry.tabCount()).toBe(0);
    expect(registry.getBySid("S-1")).toBe(runtime);
    expect(registry.hasSid("S-1")).toBe(true);
  });

  it("unregisterSid drops only the sid binding", () => {
    const registry = createSessionRegistry();
    const runtime = createRuntime("S-1", 7);

    registry.registerBySid(runtime);
    registry.unregisterSid("S-1");

    expect(registry.getBySid("S-1")).toBeUndefined();
    expect(registry.hasSid("S-1")).toBe(false);
    expect(registry.sidCount()).toBe(0);
  });

  it("iterates runtimes in insertion order", () => {
    const registry = createSessionRegistry();
    const first = createRuntime("S-1", 7);
    const second = createRuntime("S-2", 8);

    registry.register(first);
    registry.register(second);

    expect([...registry.tabRuntimes()]).toEqual([first, second]);
    expect([...registry.sidRuntimes()]).toEqual([first, second]);
  });

  it("exposes live read-only views of both indexes", () => {
    const registry = createSessionRegistry();
    const runtime = createRuntime("S-1", 7);

    expect(registry.byTab.size).toBe(0);
    registry.register(runtime);

    expect(registry.byTab.get(7)).toBe(runtime);
    expect(registry.bySid.get("S-1")).toBe(runtime);
    expect([...registry.bySid.keys()]).toEqual(["S-1"]);
  });
});

describe("createSessionRuntime", () => {
  it("passes the init fields through", () => {
    const pipeline = createPipelineStub();
    const performanceBudget = { ...DEFAULT_PERFORMANCE_BUDGET, lcpWarnMs: 4_000 };
    const runtime = createSessionRuntime(
      createInit({ pipeline, performanceBudget, title: "Example", stoppedAt: 2_000 }),
      defaultDeps
    );

    expect(runtime.sid).toBe("S-1");
    expect(runtime.tabId).toBe(7);
    expect(runtime.mode).toBe("lite");
    expect(runtime.url).toBe("https://example.test/app");
    expect(runtime.title).toBe("Example");
    expect(runtime.config).toBe(DEFAULT_RECORDER_CONFIG);
    expect(runtime.startedAt).toBe(1_000);
    expect(runtime.stoppedAt).toBe(2_000);
    expect(runtime.pipeline).toBe(pipeline);
    expect(runtime.performanceBudget).toBe(performanceBudget);
  });

  it("derives the scope origin from the url", () => {
    expect(createSessionRuntime(createInit(), defaultDeps).scopeOrigin).toBe(
      "https://example.test"
    );
    expect(
      createSessionRuntime(createInit({ url: "not a url" }), defaultDeps).scopeOrigin
    ).toBeNull();
  });

  it("initializes the profile bookkeeping and copies the annotation", () => {
    const init = createInit();
    const runtime = createSessionRuntime(init, defaultDeps);

    expect(runtime.profile.request).toBe("auto");
    expect(runtime.profile.selection).toBe(init.profile.selection);
    expect(runtime.profile.profileConfig).toBe(DEFAULT_RECORDER_CONFIG);
    expect(runtime.profile.visualsCaptured).toEqual({
      screenshots: true,
      screenRecordings: false
    });
    expect(runtime.profile.generation).toBe(0);
    expect(runtime.profile.reevaluation).toBeInstanceOf(Promise);
    expect(runtime.profile.cancellation).toBeUndefined();

    expect(runtime.tags).toEqual(["tag-a"]);
    expect(runtime.note).toBe("a note");
    init.annotation.tags.push("later");
    expect(runtime.tags).toEqual(["tag-a"]);
  });

  it("mints a unique injected bridge nonce per runtime", () => {
    const first = createSessionRuntime(createInit(), defaultDeps);
    const second = createSessionRuntime(createInit(), defaultDeps);

    expect(first.injectedBridgeNonce).toEqual(expect.any(String));
    expect(first.injectedBridgeNonce.length).toBeGreaterThan(0);
    expect(second.injectedBridgeNonce).not.toBe(first.injectedBridgeNonce);
  });

  it("resets every capture state field", () => {
    const runtime = createSessionRuntime(createInit(), defaultDeps);

    expect(runtime.recorder).toBeInstanceOf(WebBlackboxRecorder);
    expect(runtime.cdpRouter).toBeNull();
    expect(runtime.enabledCdpSessions.size).toBe(0);
    expect(runtime.requestMeta.size).toBe(0);
    expect(runtime.screenshotInterval).toBeNull();
    expect(runtime.screenRecording).toBeNull();
    expect(runtime.lastPointer).toBeNull();
    expect(runtime.lastViewport).toBeNull();
    expect(runtime.lastActionScreenshotMono).toBe(Number.NEGATIVE_INFINITY);
    expect(runtime.lastIncidentCaptureAt).toBe(Number.NEGATIVE_INFINITY);
    expect(runtime.queueDepth).toBe(0);
    expect(runtime.droppedBestEffortTasks).toBe(0);
    expect(runtime.pipelineEventBuffer).toEqual([]);
    expect(runtime.pipelineFlushTimer).toBeNull();
    expect(runtime.pipelineFlushQueued).toBe(false);
    expect(runtime.stopping).toBe(false);
    expect(runtime.cdpIngestChain).toBeInstanceOf(Promise);
    expect(runtime.cdpIngestBacklog).toBe(0);
    expect(runtime.networkBudgetSample).toEqual({ total: 0, failed: 0 });
    expect(runtime.lastFreezeNotices.size).toBe(0);
    expect(runtime.lastBudgetBreachAt.size).toBe(0);
    expect(runtime.queue).toBeInstanceOf(Promise);
    expect(runtime.removeCdpListeners).toEqual([]);
    expect(runtime.heapSnapshotCapture).toBeNull();
    expect(runtime.cleanupTimer).toBeNull();
    expect(runtime.scriptSourceMaps).toBeInstanceOf(ScriptSourceMapTracker);
    expect(runtime.scriptSourceMapFetches).toEqual(expect.any(Function));
  });

  it("zeroes the counters unless the init carries them", () => {
    const fresh = createSessionRuntime(createInit(), defaultDeps);

    expect(fresh.capturedEventCount).toBe(0);
    expect(fresh.capturedErrorCount).toBe(0);
    expect(fresh.capturedSizeBytes).toBe(0);
    expect(fresh.budgetAlertCount).toBe(0);

    const restored = createSessionRuntime(
      createInit({
        counters: { eventCount: 10, errorCount: 2, sizeBytes: 300, budgetAlertCount: 1 }
      }),
      defaultDeps
    );

    expect(restored.capturedEventCount).toBe(10);
    expect(restored.capturedErrorCount).toBe(2);
    expect(restored.capturedSizeBytes).toBe(300);
    expect(restored.budgetAlertCount).toBe(1);
  });

  it("remembers the http(s) page url without its fragment, and nothing else", () => {
    const withPage = createSessionRuntime(
      createInit({ pageUrl: "https://example.test/app#section" }),
      defaultDeps
    );
    expect([...withPage.visitedPageUrls]).toEqual(["https://example.test/app"]);

    expect(
      createSessionRuntime(createInit({ pageUrl: "chrome://extensions" }), defaultDeps)
        .visitedPageUrls.size
    ).toBe(0);
    expect(createSessionRuntime(createInit(), defaultDeps).visitedPageUrls.size).toBe(0);
  });

  it("builds the body capture through the injected factory, bound to the runtime", () => {
    let seenGetRuntime: (() => SessionRuntime) | undefined;
    const deps: SessionRuntimeDeps = {
      createFullBodyCapture: (getRuntime) => {
        seenGetRuntime = getRuntime;
        return createFullBodyCaptureStub();
      }
    };
    const runtime = createSessionRuntime(createInit(), deps);

    expect(runtime.fullBodyCapture).toBeInstanceOf(FullBodyCapture);
    expect(seenGetRuntime?.()).toBe(runtime);
  });
});
