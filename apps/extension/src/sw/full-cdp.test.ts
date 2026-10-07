/* eslint-disable max-lines -- TODO: split by subject; table-driven test file that predates the 800-line guard */
import type {
  CdpDetachHandler,
  CdpEventHandler,
  CdpRouter,
  Debuggee,
  DetachInfo,
  RawCdpEvent
} from "@webblackbox/cdp-router";
import { DEFAULT_CAPTURE_POLICY, DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins, type RawRecorderEvent } from "@webblackbox/recorder";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import type { RecordingProfile } from "../shared/profiles/model.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import type { BodyCaptureRule } from "./body-capture-utils.js";
import {
  createFullCdpController,
  HEAP_SNAPSHOT_MAX_BYTES,
  readContentScriptRecord,
  toScriptScanStatus,
  type FullCdpController,
  type FullCdpDeps
} from "./full-cdp.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createSessionRuntime, type SessionRuntime } from "./session-registry.js";
import { SCRIPT_RAW_TYPE, type RawScriptRecord } from "./source-maps.js";

const TEXT_RULE: BodyCaptureRule = {
  enabled: true,
  maxBytes: 1024 * 1024,
  mimeAllowlist: ["text/*"]
};

const TAB_ID = 7;

type SentCommand = {
  target: Debuggee;
  method: string;
  params?: Record<string, unknown>;
};

type FakeRouterKit = {
  router: CdpRouter;
  sent: SentCommand[];
  attachedTabs: number[];
  detachedTabs: number[];
  baselineCalls: Array<{ tabId: number; sessionId?: string }>;
  emit: (event: RawCdpEvent) => void;
  emitDetach: (info: DetachInfo) => void;
  disposed: () => boolean;
};

function createFakeRouter(
  options: {
    attachError?: string;
    detachError?: string;
    sendError?: (method: string) => string | null;
    sendResult?: (method: string) => unknown;
    childBaselineError?: string;
  } = {}
): FakeRouterKit {
  const eventHandlers = new Set<CdpEventHandler>();
  const detachHandlers = new Set<CdpDetachHandler>();
  const sent: SentCommand[] = [];
  const attachedTabs: number[] = [];
  const detachedTabs: number[] = [];
  const baselineCalls: Array<{ tabId: number; sessionId?: string }> = [];
  let isDisposed = false;

  const router: CdpRouter = {
    attach: (tabId) => {
      attachedTabs.push(tabId);
      return options.attachError
        ? Promise.reject(new Error(options.attachError))
        : Promise.resolve();
    },
    detach: (tabId) => {
      detachedTabs.push(tabId);
      return options.detachError
        ? Promise.reject(new Error(options.detachError))
        : Promise.resolve();
    },
    send: <TResult>(target: Debuggee, method: string, params?: Record<string, unknown>) => {
      sent.push({ target, method, params });
      const error = options.sendError?.(method);

      return error
        ? Promise.reject(new Error(error))
        : Promise.resolve(options.sendResult?.(method) as TResult);
    },
    enableBaseline: (tabId, sessionId) => {
      baselineCalls.push({ tabId, sessionId });
      return options.childBaselineError && sessionId
        ? Promise.reject(new Error(options.childBaselineError))
        : Promise.resolve();
    },
    enableAutoAttach: () => Promise.resolve(),
    getAttachedTargets: () => [],
    onEvent: (callback) => {
      eventHandlers.add(callback);
      return () => {
        eventHandlers.delete(callback);
      };
    },
    onDetach: (callback) => {
      detachHandlers.add(callback);
      return () => {
        detachHandlers.delete(callback);
      };
    },
    dispose: () => {
      isDisposed = true;
    }
  };

  return {
    router,
    sent,
    attachedTabs,
    detachedTabs,
    baselineCalls,
    emit: (event) => {
      for (const handler of eventHandlers) {
        handler(event);
      }
    },
    emitDetach: (info) => {
      for (const handler of detachHandlers) {
        handler(info);
      }
    },
    disposed: () => isDisposed
  };
}

type IngestedEvent = {
  event: RawRecorderEvent;
  options?: { arrivedBeforeStop?: boolean };
};

type DepsHarness = {
  deps: FullCdpDeps;
  controller: FullCdpController;
  routerKit: FakeRouterKit;
  ingested: IngestedEvent[];
  enqueueCalls: Array<{ bestEffort: boolean }>;
  pendingTasks: Array<Promise<void>>;
  stoppedTabs: number[];
  artifactReasons: string[];
  screenshotReasons: string[];
  incidentReasons: string[];
  ruleCalls: Array<{ url: string; mimeType: string | undefined }>;
  flushTasks: () => Promise<void>;
};

function createDepsHarness(
  options: {
    router?: Parameters<typeof createFakeRouter>[0];
    incidentsEnabled?: boolean;
    rule?: BodyCaptureRule;
  } = {}
): DepsHarness {
  const ingested: IngestedEvent[] = [];
  const enqueueCalls: Array<{ bestEffort: boolean }> = [];
  const pendingTasks: Array<Promise<void>> = [];
  const stoppedTabs: number[] = [];
  const artifactReasons: string[] = [];
  const screenshotReasons: string[] = [];
  const incidentReasons: string[] = [];
  const ruleCalls: Array<{ url: string; mimeType: string | undefined }> = [];
  const routerKit = createFakeRouter(options.router);

  const deps: FullCdpDeps = {
    createRouter: () => routerKit.router,
    ingestRawEvent: (event, ingestOptions) => {
      ingested.push({ event, options: ingestOptions });
    },
    enqueue: (_runtime, task, enqueueOptions) => {
      enqueueCalls.push({ bestEffort: enqueueOptions?.bestEffort === true });
      pendingTasks.push(task());
      return true;
    },
    stopSession: (tabId) => {
      stoppedTabs.push(tabId);
      return Promise.resolve();
    },
    captureFullModeArtifacts: (_runtime, reason) => {
      artifactReasons.push(reason);
      return Promise.resolve();
    },
    captureScreenshot: (_runtime, reason) => {
      screenshotReasons.push(reason);
      return Promise.resolve();
    },
    shouldCaptureIncidentArtifacts: () => options.incidentsEnabled ?? true,
    captureIncidentArtifacts: (_runtime, reason) => {
      incidentReasons.push(reason);
      return Promise.resolve();
    },
    resolveBodyRule: (_runtime, url, mimeType) => {
      ruleCalls.push({ url, mimeType });
      return options.rule ?? TEXT_RULE;
    },
    bodyRedactedToken: "[REDACTED]"
  };

  return {
    deps,
    controller: createFullCdpController(deps),
    routerKit,
    ingested,
    enqueueCalls,
    pendingTasks,
    stoppedTabs,
    artifactReasons,
    screenshotReasons,
    incidentReasons,
    ruleCalls,
    flushTasks: async () => {
      await Promise.all(pendingTasks);
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

function fullBodyConfig(): typeof DEFAULT_RECORDER_CONFIG {
  return {
    ...DEFAULT_RECORDER_CONFIG,
    capturePolicy: {
      ...DEFAULT_CAPTURE_POLICY,
      categories: {
        ...DEFAULT_CAPTURE_POLICY.categories,
        network: "body-allowlist"
      }
    }
  };
}

function createRuntime(
  controller: FullCdpController,
  overrides: {
    mode?: "lite" | "full";
    profile?: RecordingProfile;
    config?: typeof DEFAULT_RECORDER_CONFIG;
  } = {}
): SessionRuntime {
  return createSessionRuntime(
    {
      sid: "S-1",
      tabId: TAB_ID,
      mode: overrides.mode ?? "full",
      profile: {
        request: "auto",
        selection: {
          profile: overrides.profile ?? createDefaultProfile(),
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
    { createFullBodyCapture: controller.createFullBodyCapture }
  );
}

function cdpEventsOf(harness: DepsHarness): RawRecorderEvent[] {
  return harness.ingested.map(({ event }) => event);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("attachCdp", () => {
  it("attaches, enables the baseline domains and records the router on the session", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);

    await harness.controller.attachCdp(runtime);

    expect(harness.routerKit.attachedTabs).toEqual([TAB_ID]);
    expect(harness.routerKit.baselineCalls).toEqual([{ tabId: TAB_ID, sessionId: undefined }]);
    expect(runtime.cdpRouter).toBe(harness.routerKit.router);
    expect([...runtime.enabledCdpSessions]).toEqual(["root"]);

    const methods = harness.routerKit.sent.map(({ method }) => method);
    expect(methods).toContain("DOMStorage.enable");
    expect(methods).toContain("Performance.enable");
    // The default profile records source map metadata in Full mode, so the debugger is enabled.
    expect(methods).toContain("Debugger.enable");
    expect(methods).toContain("Debugger.setSkipAllPauses");

    expect(harness.artifactReasons).toEqual(["session-start"]);
    await harness.flushTasks();
    expect(runtime.screenshotInterval).toBeNull();
  });

  it("skips the script debugger when the profile turns source maps off", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, {
      profile: { ...createDefaultProfile(), sourceMaps: { mode: "off" } }
    });

    await harness.controller.attachCdp(runtime);

    const methods = harness.routerKit.sent.map(({ method }) => method);
    expect(methods).not.toContain("Debugger.enable");
  });

  it("schedules interval screenshots when the sampling config asks for them", async () => {
    vi.useFakeTimers();
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, {
      config: {
        ...DEFAULT_RECORDER_CONFIG,
        sampling: { ...DEFAULT_RECORDER_CONFIG.sampling, screenshotIdleMs: 30_000 }
      }
    });

    await harness.controller.attachCdp(runtime);
    expect(runtime.screenshotInterval).not.toBeNull();

    vi.advanceTimersByTime(30_000);
    expect(harness.screenshotReasons).toEqual(["interval"]);

    await harness.controller.cleanupCdpInstrumentation(runtime, runtime.cdpRouter);
    expect(runtime.screenshotInterval).toBeNull();
  });

  it("continues without CDP when the debugger cannot attach, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createDepsHarness({ router: { attachError: "not allowed" } });
    const runtime = createRuntime(harness.controller);

    await harness.controller.attachCdp(runtime);

    expect(runtime.cdpRouter).toBeNull();
    expect(runtime.enabledCdpSessions.size).toBe(0);
    expect(harness.routerKit.disposed()).toBe(true);
    expect(harness.artifactReasons).toEqual([]);
    expect(
      warn.mock.calls.some(([message]) => message === "[WebBlackbox] failed to attach debugger")
    ).toBe(true);
  });

  it("warns and continues when an optional domain fails to enable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createDepsHarness({
      router: { sendError: (method) => (method === "DOMStorage.enable" ? "no domain" : null) }
    });
    const runtime = createRuntime(harness.controller);

    await harness.controller.attachCdp(runtime);

    expect(runtime.cdpRouter).toBe(harness.routerKit.router);
    expect(harness.routerKit.sent.map(({ method }) => method)).toContain("Performance.enable");
    expect(
      warn.mock.calls.some(
        ([message]) => message === "[WebBlackbox] failed to enable DOMStorage domain"
      )
    ).toBe(true);
  });

  it("warns and continues when the script debugger cannot be enabled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createDepsHarness({
      router: { sendError: (method) => (method === "Debugger.enable" ? "no debugger" : null) }
    });
    const runtime = createRuntime(harness.controller);

    await harness.controller.attachCdp(runtime);

    expect(runtime.cdpRouter).toBe(harness.routerKit.router);
    expect(
      warn.mock.calls.some(
        ([message]) => message === "[WebBlackbox] failed to enable script source map capture"
      )
    ).toBe(true);
  });

  it("stops the session when the debugger detaches from its tab", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);

    await harness.controller.attachCdp(runtime);
    harness.routerKit.emitDetach({ tabId: 999, reason: "target_closed" });
    expect(harness.stoppedTabs).toEqual([]);

    harness.routerKit.emitDetach({ tabId: TAB_ID, reason: "target_closed" });
    expect(harness.stoppedTabs).toEqual([TAB_ID]);
  });
});

describe("CDP event routing", () => {
  it("ingests CDP events as raw events with the session id, except scriptParsed", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      sessionId: "child-9",
      method: "Page.loadEventFired",
      params: { timestamp: 1.5 }
    });

    const cdpEvent = cdpEventsOf(harness).find((event) => event.rawType === "Page.loadEventFired");
    expect(cdpEvent).toMatchObject({
      source: "cdp",
      rawType: "Page.loadEventFired",
      tabId: TAB_ID,
      sid: "S-1",
      cdpSessionId: "child-9",
      payload: { timestamp: 1.5 }
    });

    // A script with a source map becomes a script record, not a CDP raw event.
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Debugger.scriptParsed",
      params: {
        url: "https://example.test/app.js",
        sourceMapURL: "app.js.map",
        scriptId: "1"
      }
    });

    expect(cdpEventsOf(harness).some((event) => event.rawType === "Debugger.scriptParsed")).toBe(
      false
    );
    const scriptEvent = cdpEventsOf(harness).find((event) => event.rawType === SCRIPT_RAW_TYPE);
    expect(scriptEvent).toMatchObject({
      source: "system",
      payload: {
        url: "https://example.test/app.js",
        sourceMapUrl: "app.js.map",
        origin: "cdp",
        scriptId: "1"
      }
    });

    // A script without a map ingests nothing at all.
    const before = harness.ingested.length;
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Debugger.scriptParsed",
      params: { url: "https://example.test/other.js", scriptId: "2" }
    });
    expect(harness.ingested.length).toBe(before);
  });

  it("collects heap snapshot chunks and still ingests them as raw events", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);
    runtime.heapSnapshotCapture = { chunks: [], bytes: 0, truncated: false };

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "HeapProfiler.addHeapSnapshotChunk",
      params: { chunk: "abc" }
    });

    expect(runtime.heapSnapshotCapture).toEqual({ chunks: ["abc"], bytes: 3, truncated: false });
    expect(
      cdpEventsOf(harness).some(
        (event) => event.rawType === "HeapProfiler.addHeapSnapshotChunk" && event.source === "cdp"
      )
    ).toBe(true);

    runtime.heapSnapshotCapture.bytes = HEAP_SNAPSHOT_MAX_BYTES - 1;
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "HeapProfiler.addHeapSnapshotChunk",
      params: { chunk: "ab" }
    });

    expect(runtime.heapSnapshotCapture.chunks).toEqual(["abc"]);
    expect(runtime.heapSnapshotCapture.truncated).toBe(true);
  });

  it("primes auto-attached child sessions as a required follow-up", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Target.attachedToTarget",
      params: { sessionId: "child-1" }
    });
    await harness.flushTasks();

    // Required follow-ups never run best-effort (they must not be dropped under load).
    expect(harness.enqueueCalls.at(-1)).toEqual({ bestEffort: false });
    expect(runtime.enabledCdpSessions.has("child-1")).toBe(true);
    expect(harness.routerKit.baselineCalls).toContainEqual({
      tabId: TAB_ID,
      sessionId: "child-1"
    });
    expect(
      harness.routerKit.sent.some(
        ({ target, method }) =>
          method === "Debugger.enable" && (target as { sessionId?: string }).sessionId === "child-1"
      )
    ).toBe(true);

    // A repeated attach for the same session is not primed again.
    const baselineCount = harness.routerKit.baselineCalls.length;
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Target.attachedToTarget",
      params: { sessionId: "child-1" }
    });
    await harness.flushTasks();
    expect(harness.routerKit.baselineCalls.length).toBe(baselineCount);
  });

  it("drops the child session when priming fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createDepsHarness({
      router: { childBaselineError: "No session with given id" }
    });
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Target.attachedToTarget",
      params: { sessionId: "gone" }
    });
    await harness.flushTasks();

    expect(runtime.enabledCdpSessions.has("gone")).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(
      "[WebBlackbox] failed to enable script source map capture"
    );
  });

  it("forgets detached child sessions", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);
    runtime.enabledCdpSessions.add("child-1");

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Target.detachedFromTarget",
      params: { sessionId: "child-1" }
    });
    await harness.flushTasks();

    expect(runtime.enabledCdpSessions.has("child-1")).toBe(false);
  });

  it("captures incident artifacts for exceptions and failed loads when the gate allows", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: {} }
    });
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.loadingFailed",
      params: { requestId: "r-1" }
    });
    await harness.flushTasks();

    expect(harness.incidentReasons).toEqual(["Runtime.exceptionThrown", "Network.loadingFailed"]);
    // Incident follow-ups are best-effort: they may be dropped under load.
    expect(harness.enqueueCalls.slice(-2)).toEqual([{ bestEffort: true }, { bestEffort: true }]);
  });

  it("skips incident artifacts when the gate disallows them or the session stops", async () => {
    const harness = createDepsHarness({ incidentsEnabled: false });
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: {} }
    });
    await harness.flushTasks();
    expect(harness.incidentReasons).toEqual([]);

    const gated = createDepsHarness();
    const stoppingRuntime = createRuntime(gated.controller);
    await gated.controller.attachCdp(stoppingRuntime);
    stoppingRuntime.stopping = true;
    gated.routerKit.emit({
      tabId: TAB_ID,
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: {} }
    });
    await gated.flushTasks();
    expect(gated.incidentReasons).toEqual([]);
  });

  it("skips network bookkeeping once the session is stopping", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);
    runtime.stopping = true;

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.responseReceived",
      params: {
        requestId: "r-1",
        type: "Document",
        response: { url: "https://example.test/", mimeType: "text/html", status: 200 }
      }
    });

    expect(runtime.requestMeta.size).toBe(0);
  });
});

describe("full-mode body capture", () => {
  function emitTextResponse(harness: DepsHarness, requestId: string): void {
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.requestWillBeSent",
      params: { requestId, request: { url: "https://example.test/", method: "GET" } }
    });
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.responseReceived",
      params: {
        requestId,
        type: "Document",
        response: {
          url: "https://example.test/",
          mimeType: "text/html",
          status: 200,
          encodedDataLength: 100
        }
      }
    });
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.loadingFinished",
      params: { requestId, encodedDataLength: 500 }
    });
  }

  it("reads a finished textual response through CDP and records the stored body", async () => {
    const harness = createDepsHarness({
      router: {
        sendResult: (method) =>
          method === "Network.getResponseBody"
            ? { body: "<html>hi</html>", base64Encoded: false }
            : {}
      }
    });
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);

    emitTextResponse(harness, "r-1");

    await vi.waitFor(() => {
      expect(cdpEventsOf(harness).some((event) => event.rawType === "cdp.network.body")).toBe(true);
    });

    const read = harness.routerKit.sent.find(({ method }) => method === "Network.getResponseBody");
    expect(read).toMatchObject({ target: { tabId: TAB_ID }, params: { requestId: "r-1" } });

    const bodyEvent = cdpEventsOf(harness).find((event) => event.rawType === "cdp.network.body");
    expect(bodyEvent).toMatchObject({
      source: "system",
      payload: {
        reqId: "r-1",
        contentHash: "blob-hash",
        mimeType: "text/html",
        redacted: false,
        truncated: false
      }
    });
    expect(harness.ruleCalls).toEqual([{ url: "https://example.test/", mimeType: "text/html" }]);
    // The metadata of the finished request is forgotten.
    expect(runtime.requestMeta.size).toBe(0);
  });

  it("records a skip when the browser no longer holds the body", async () => {
    const harness = createDepsHarness({
      router: {
        sendError: (method) =>
          method === "Network.getResponseBody" ? "No resource with given identifier found" : null
      }
    });
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);

    emitTextResponse(harness, "r-1");

    await vi.waitFor(() => {
      expect(
        cdpEventsOf(harness).some((event) => event.rawType === "cdp.network.body.skipped")
      ).toBe(true);
    });

    const skip = cdpEventsOf(harness).find((event) => event.rawType === "cdp.network.body.skipped");
    expect(skip).toMatchObject({
      source: "system",
      payload: { reqId: "r-1", side: "response", reason: "not-retained" }
    });
  });

  it("reports a failed read when the debugger is already detached", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });

    // Never attached: the body read fails as "debugger detached" and becomes a skip.
    const meta = {
      url: "https://example.test/",
      mimeType: "text/html",
      status: 200,
      resourceType: "Document",
      updatedAt: Date.now()
    };
    runtime.fullBodyCapture.onRequestWillBeSent("r-1", undefined);
    runtime.fullBodyCapture.onResponseReceived({ requestId: "r-1", meta });
    runtime.fullBodyCapture.onLoadingFinished({ requestId: "r-1", meta });

    await vi.waitFor(() => {
      expect(
        cdpEventsOf(harness).some((event) => event.rawType === "cdp.network.body.skipped")
      ).toBe(true);
    });

    const skip = cdpEventsOf(harness).find((event) => event.rawType === "cdp.network.body.skipped");
    expect(skip).toMatchObject({
      payload: { reqId: "r-1", reason: "fetch-failed", detail: "debugger detached" }
    });
  });

  it("does not read bodies when the policy keeps only metadata", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    emitTextResponse(harness, "r-1");
    await harness.flushTasks();

    expect(harness.routerKit.sent.some(({ method }) => method === "Network.getResponseBody")).toBe(
      false
    );
    expect(cdpEventsOf(harness).some((event) => event.rawType === "cdp.network.body")).toBe(false);
  });

  it("reads a request body CDP left out and keeps the event order", async () => {
    const harness = createDepsHarness({
      router: {
        sendResult: (method) =>
          method === "Network.getRequestPostData" ? { postData: "hello world" } : {}
      }
    });
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.requestWillBeSent",
      params: {
        requestId: "r-post",
        request: { url: "https://example.test/form", method: "POST", hasPostData: true }
      }
    });
    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.responseReceived",
      params: {
        requestId: "r-post",
        type: "Document",
        response: { url: "https://example.test/form", mimeType: "text/html", status: 200 }
      }
    });

    // The response waits behind the pending post-data read.
    await runtime.cdpIngestChain;

    const request = harness.routerKit.sent.find(
      ({ method }) => method === "Network.getRequestPostData"
    );
    expect(request).toMatchObject({ params: { requestId: "r-post" } });

    const [first, second] = harness.ingested;
    expect(first?.event.rawType).toBe("Network.requestWillBeSent");
    expect(first?.event.payload).toMatchObject({
      request: { url: "https://example.test/form", method: "POST", postData: "hello world" }
    });
    expect(second?.event.rawType).toBe("Network.responseReceived");
    expect(second?.options).toEqual({ arrivedBeforeStop: true });
  });

  it("marks the request body skipped when the post-data read fails", async () => {
    const harness = createDepsHarness({
      router: {
        sendError: (method) =>
          method === "Network.getRequestPostData" ? "No post data available" : null
      }
    });
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.requestWillBeSent",
      params: {
        requestId: "r-post",
        request: { url: "https://example.test/form", method: "POST", hasPostData: true }
      }
    });
    await runtime.cdpIngestChain;

    const [first] = harness.ingested;
    expect(first?.event.payload).toMatchObject({
      request: { postDataSkipped: "unavailable" }
    });
  });

  it("skips the post-data read once the ingest backlog is full", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);
    runtime.cdpIngestBacklog = 500;

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.requestWillBeSent",
      params: {
        requestId: "r-post",
        request: { url: "https://example.test/form", method: "POST", hasPostData: true }
      }
    });

    expect(
      harness.routerKit.sent.some(({ method }) => method === "Network.getRequestPostData")
    ).toBe(false);
    // The backlog is non-zero, so the (synchronously prepared) event still lands via the chain.
    await runtime.cdpIngestChain;
    const [first] = harness.ingested;
    expect(first?.event.payload).toMatchObject({ request: { postDataSkipped: "backlog" } });
  });

  it("passes requests with an inline body through without a CDP read", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, { config: fullBodyConfig() });
    await harness.controller.attachCdp(runtime);

    harness.routerKit.emit({
      tabId: TAB_ID,
      method: "Network.requestWillBeSent",
      params: {
        requestId: "r-inline",
        request: {
          url: "https://example.test/form",
          method: "POST",
          hasPostData: true,
          postData: "a=1"
        }
      }
    });

    expect(
      harness.routerKit.sent.some(({ method }) => method === "Network.getRequestPostData")
    ).toBe(false);
    const [first] = harness.ingested;
    expect(first?.event.payload).toMatchObject({
      request: { postData: "a=1" }
    });
    expect(first?.options).toBeUndefined();
  });
});

describe("script source map records", () => {
  const INLINE_MAP_URL = `data:application/json;base64,${Buffer.from(
    JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA" })
  ).toString("base64")}`;

  it("records a map reference once per session", () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    const record: RawScriptRecord = {
      url: "https://example.test/app.js",
      sourceMapUrl: "app.js.map",
      origin: "header"
    };

    harness.controller.recordScriptSourceMap(runtime, record);
    harness.controller.recordScriptSourceMap(runtime, record);

    const scriptEvents = cdpEventsOf(harness).filter((event) => event.rawType === SCRIPT_RAW_TYPE);
    expect(scriptEvents).toHaveLength(1);
    expect(scriptEvents[0]).toMatchObject({ source: "system", payload: record });
  });

  it("ignores records when the session is stopping or the profile turns capture off", () => {
    const harness = createDepsHarness();
    const stopping = createRuntime(harness.controller);
    stopping.stopping = true;
    const record: RawScriptRecord = {
      url: "https://example.test/app.js",
      sourceMapUrl: "app.js.map",
      origin: "header"
    };

    harness.controller.recordScriptSourceMap(stopping, record);

    const off = createRuntime(harness.controller, {
      profile: { ...createDefaultProfile(), sourceMaps: { mode: "off" } }
    });
    harness.controller.recordScriptSourceMap(off, record);

    expect(harness.ingested).toEqual([]);
  });

  it("embeds an inline map as a blob and records it in a follow-up event", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, {
      profile: { ...createDefaultProfile(), sourceMaps: { mode: "embed" } }
    });
    const record: RawScriptRecord = {
      url: "https://example.test/app.js",
      sourceMapUrl: INLINE_MAP_URL,
      origin: "comment"
    };

    harness.controller.recordScriptSourceMap(runtime, record);

    await vi.waitFor(() => {
      const events = cdpEventsOf(harness).filter((event) => event.rawType === SCRIPT_RAW_TYPE);
      expect(events).toHaveLength(2);
    });

    const [reference, embedded] = cdpEventsOf(harness).filter(
      (event) => event.rawType === SCRIPT_RAW_TYPE
    );
    expect(reference?.payload).toEqual(record);
    expect(embedded?.payload).toMatchObject({
      ...record,
      map: { contentHash: "blob-hash" }
    });
    expect((embedded?.payload as { map: { size: number } }).map.size).toBeGreaterThan(0);
  });

  it("records the map error when the map cannot be loaded", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller, {
      profile: { ...createDefaultProfile(), sourceMaps: { mode: "embed" } }
    });
    const record: RawScriptRecord = {
      url: "https://example.test/app.js",
      // Decodes to bytes that are not a version 3 source map.
      sourceMapUrl: "data:application/json;base64,AAAA",
      origin: "comment"
    };

    harness.controller.recordScriptSourceMap(runtime, record);

    await vi.waitFor(() => {
      const events = cdpEventsOf(harness).filter((event) => event.rawType === SCRIPT_RAW_TYPE);
      expect(events).toHaveLength(2);
    });

    const [, failed] = cdpEventsOf(harness).filter((event) => event.rawType === SCRIPT_RAW_TYPE);
    expect(failed?.payload).toMatchObject({
      ...record,
      mapError: "response is not a source map"
    });
  });
});

describe("readContentScriptRecord", () => {
  it("reads scanner records with a header or comment origin", () => {
    expect(
      readContentScriptRecord({
        url: "https://example.test/app.js",
        sourceMapUrl: "app.js.map",
        origin: "header"
      })
    ).toEqual({
      url: "https://example.test/app.js",
      sourceMapUrl: "app.js.map",
      origin: "header"
    });
    expect(
      readContentScriptRecord({
        url: "https://example.test/app.js",
        sourceMapUrl: "app.js.map",
        origin: "comment"
      })
    ).toMatchObject({ origin: "comment" });
  });

  it("rejects records without a URL, a map URL or a scanner origin", () => {
    expect(
      readContentScriptRecord({
        url: "https://example.test/app.js",
        sourceMapUrl: "app.js.map",
        origin: "cdp"
      })
    ).toBeNull();
    expect(readContentScriptRecord({ url: "https://example.test/app.js" })).toBeNull();
    expect(readContentScriptRecord({ sourceMapUrl: "app.js.map", origin: "header" })).toBeNull();
    expect(readContentScriptRecord("nope")).toBeNull();
    expect(readContentScriptRecord(null)).toBeNull();
  });
});

describe("toScriptScanStatus", () => {
  it("asks lite pages to scan scripts only when the profile captures maps", () => {
    const harness = createDepsHarness();

    const liteScanning = createRuntime(harness.controller, {
      mode: "lite",
      profile: { ...createDefaultProfile(), sourceMaps: { mode: "metadata" } }
    });
    expect(toScriptScanStatus(liteScanning)).toEqual({ scriptSourceMaps: true });

    // The default profile captures no maps in Lite mode.
    const liteDefault = createRuntime(harness.controller, { mode: "lite" });
    expect(toScriptScanStatus(liteDefault)).toEqual({});

    // Full mode never scans page-side: the debugger reports scripts itself.
    const full = createRuntime(harness.controller, {
      profile: { ...createDefaultProfile(), sourceMaps: { mode: "embed" } }
    });
    expect(toScriptScanStatus(full)).toEqual({});
  });
});

describe("cleanupCdpInstrumentation", () => {
  it("detaches the router, disposes listeners and resets the session CDP state", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    runtime.screenshotInterval = globalThis.setInterval(() => undefined, 60_000);
    runtime.heapSnapshotCapture = { chunks: [], bytes: 0, truncated: false };
    runtime.requestMeta.set("root:r-1", { url: "https://example.test/", updatedAt: Date.now() });
    const ingestedBefore = harness.ingested.length;

    await harness.controller.cleanupCdpInstrumentation(runtime, runtime.cdpRouter);

    expect(harness.routerKit.detachedTabs).toEqual([TAB_ID]);
    expect(harness.routerKit.disposed()).toBe(true);
    expect(runtime.cdpRouter).toBeNull();
    expect(runtime.screenshotInterval).toBeNull();
    expect(runtime.enabledCdpSessions.size).toBe(0);
    expect(runtime.requestMeta.size).toBe(0);
    expect(runtime.heapSnapshotCapture).toBeNull();
    expect(runtime.removeCdpListeners).toEqual([]);

    // The event listener is gone: later CDP events ingest nothing.
    harness.routerKit.emit({ tabId: TAB_ID, method: "Page.loadEventFired", params: {} });
    expect(harness.ingested.length).toBe(ingestedBefore);
  });

  it("warns and finishes when the detach itself fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createDepsHarness({ router: { detachError: "already detached" } });
    const runtime = createRuntime(harness.controller);
    await harness.controller.attachCdp(runtime);

    await harness.controller.cleanupCdpInstrumentation(runtime, runtime.cdpRouter);

    expect(runtime.cdpRouter).toBeNull();
    expect(
      warn.mock.calls.some(([message]) => message === "[WebBlackbox] failed to detach debugger")
    ).toBe(true);
  });

  it("tolerates a session that never attached", async () => {
    const harness = createDepsHarness();
    const runtime = createRuntime(harness.controller);

    await harness.controller.cleanupCdpInstrumentation(runtime, null);

    expect(runtime.cdpRouter).toBeNull();
    expect(runtime.enabledCdpSessions.size).toBe(0);
  });
});
