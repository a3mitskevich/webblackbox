import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { describe, expect, it, vi, type Mock } from "vitest";

import type { PortLike, RuntimeMessageSender } from "../shared/chrome-api.js";
import { PORT_NAMES } from "../shared/messages.js";
import { normalizeEnterprisePolicy } from "../shared/options-storage.js";
import type { OffscreenEventMessage } from "./offscreen-client.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import {
  createInboundRouter,
  type InboundRouter,
  type InboundRouterDeps
} from "./inbound-router.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { createPortRegistry, type PortRegistry } from "./port-registry.js";
import { createPortTrafficMeter } from "./port-traffic.js";
import {
  createSessionRegistry,
  createSessionRuntime,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";
import { createStopDrainTracker, type StopDrainTracker } from "./stop-drain.js";

const EXTENSION_ID = "ext-id";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const OFFSCREEN_URL = `${EXTENSION_ORIGIN}/offscreen.html`;

type FakePort = PortLike & {
  sent: unknown[];
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitMessage: (message: unknown) => void;
  emitDisconnect: () => void;
};

function createPort(name: string, sender?: RuntimeMessageSender): FakePort {
  const messageHandlers = new Set<(message: unknown) => void>();
  const disconnectHandlers = new Set<() => void>();
  const port = {
    name,
    sender,
    sent: [] as unknown[],
    onMessage: {
      addListener: vi.fn((handler: (message: unknown) => void) => {
        messageHandlers.add(handler);
      }),
      removeListener: vi.fn((handler: (message: unknown) => void) => {
        messageHandlers.delete(handler);
      })
    },
    onDisconnect: {
      addListener: vi.fn((handler: () => void) => {
        disconnectHandlers.add(handler);
      }),
      removeListener: vi.fn((handler: () => void) => {
        disconnectHandlers.delete(handler);
      })
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    emitMessage: (message: unknown) => {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
    emitDisconnect: () => {
      for (const handler of disconnectHandlers) {
        handler();
      }
    }
  };

  port.postMessage.mockImplementation((message: unknown) => {
    port.sent.push(message);
  });

  return port;
}

function contentSender(tabId = 7, frameId = 0): RuntimeMessageSender {
  return { id: EXTENSION_ID, url: "https://page.test/app", tab: { id: tabId }, frameId };
}

function extensionPageSender(): RuntimeMessageSender {
  return { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/popup.html` };
}

function offscreenSender(): RuntimeMessageSender {
  return { id: EXTENSION_ID, url: OFFSCREEN_URL };
}

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
      url: "https://page.test/app",
      title: "Page",
      annotation: { tags: [] },
      config: DEFAULT_RECORDER_CONFIG,
      startedAt: 1_000,
      pipeline: createPipelineStub(),
      recorderPlugins: createDefaultRecorderPlugins(),
      performanceBudget: { ...DEFAULT_PERFORMANCE_BUDGET },
      ...overrides
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

type Harness = {
  router: InboundRouter;
  portRegistry: PortRegistry;
  stopDrain: StopDrainTracker;
  sessionRegistry: ReturnType<typeof createSessionRegistry>;
  deps: InboundRouterDeps;
  sendResponse: Mock<(response: unknown) => void>;
};

function createHarness(overrides: Partial<InboundRouterDeps> = {}): Harness {
  const sessionRegistry = createSessionRegistry();
  const portRegistry = createPortRegistry({
    offscreenPortTraffic: createPortTrafficMeter({}),
    shouldLogPortDebug: () => false
  });
  const stopDrain = createStopDrainTracker({
    getRuntimeBySid: (sid) => sessionRegistry.getBySid(sid)
  });

  const deps: InboundRouterDeps = {
    sessionRegistry,
    portRegistry,
    stopDrain,
    offscreenClient: {
      request: vi.fn(),
      requestOnce: vi.fn(),
      post: vi.fn(),
      receive: vi.fn(() => null),
      rejectPending: vi.fn(),
      pendingCount: () => 0
    } as unknown as InboundRouterDeps["offscreenClient"],
    screenRecording: {
      handleOffscreenScreenRecordingChunk: vi.fn(),
      handleOffscreenScreenRecordingEnded: vi.fn(async () => undefined),
      handleOffscreenScreenRecordingError: vi.fn()
    },
    sessionCommands: {
      startSession: vi.fn(async () => "lite" as const),
      stopSession: vi.fn(async () => undefined),
      reloadRecordingTab: vi.fn(async () => undefined),
      deleteSessionBySid: vi.fn(async () => undefined),
      acknowledgeProfileCancel: vi.fn(async () => undefined),
      setIdleBadge: vi.fn(async () => undefined),
      setRecordingBadge: vi.fn(async () => undefined),
      setFreezeBadge: vi.fn(async () => undefined),
      refreshActionBadge: vi.fn(async () => undefined),
      notifyTabStatus: vi.fn(async () => undefined),
      resolveFullBodyCaptureRule: vi.fn(),
      persistRuntimeState: vi.fn(async () => undefined),
      restoreRuntimeState: vi.fn(async () => undefined)
    },
    sessionList: {
      buildSessionListMessage: vi.fn(() => ({ kind: "sw.session-list" as const, sessions: [] })),
      broadcastSessionList: vi.fn()
    },
    sessionExport: {
      exportSession: vi.fn(async () => ({ ok: true as const, fileName: "session.wbbx" })),
      resolveExportPolicy: vi.fn((value: unknown) => value as never),
      appendExportAuditEvent: vi.fn(async () => undefined)
    },
    annotations: {
      get: vi.fn(() => ({ tags: [] })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => false),
      load: vi.fn(async () => undefined)
    },
    profile: {
      loadSessionProfilesState: vi.fn(),
      loadEnterprisePolicy: vi.fn(async () => normalizeEnterprisePolicy({})),
      resolveTabProfileSelection: vi.fn(async () => null),
      resolveProfilePreview: vi.fn(async () => ({ kind: "sw.profile-preview" }) as never),
      scheduleProfileReevaluation: vi.fn()
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_ORIGIN}/${path}`
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7 }]),
      sendMessage: vi.fn(async () => undefined)
    },
    scripting: {
      executeScript: vi.fn(async () => undefined)
    },
    offscreenPath: "offscreen.html",
    resolveUiActionTarget: vi.fn(async (requestedTabId?: number) => requestedTabId),
    ingestRawEvent: vi.fn(),
    sendAtRestKeyToOffscreen: vi.fn(async () => undefined),
    recoverActiveOffscreenPipelines: vi.fn(async () => undefined),
    markStoppedPipelinesDetached: vi.fn(),
    waitForRuntimeState: () => Promise.resolve(),
    pushSessionList: vi.fn(),
    wait: vi.fn(async () => undefined),
    monotonicTime: () => 1_000,
    perfNow: () => 0,
    shouldLogPortDebug: () => false,
    ...overrides
  };

  return {
    router: createInboundRouter(deps),
    portRegistry,
    stopDrain,
    sessionRegistry,
    deps,
    sendResponse: vi.fn<(response: unknown) => void>()
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("sender trust resolution", () => {
  it("rejects a port from a foreign sender and disconnects it", () => {
    const { router, portRegistry } = createHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createPort(PORT_NAMES.popup, { id: "other-extension", url: "https://x.test" });

    router.handlePortConnect(port);

    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(portRegistry.hasPort(port)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] rejected port from untrusted sender",
      expect.objectContaining({ portName: PORT_NAMES.popup })
    );
    warn.mockRestore();
  });

  it("rejects a content port claimed by an extension page", () => {
    const { router, portRegistry } = createHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createPort(PORT_NAMES.content, {
      id: EXTENSION_ID,
      url: `${EXTENSION_ORIGIN}/options.html`,
      tab: { id: 7 },
      frameId: 0
    });

    router.handlePortConnect(port);

    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(portRegistry.hasPort(port)).toBe(false);
    warn.mockRestore();
  });

  it("refuses an offscreen port whose sender URL only matches after fragment stripping", () => {
    const { router, portRegistry } = createHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The sender classification strips the fragment; the offscreen check requires the exact
    // offscreen document URL, so this port passes the first gate and is refused by the second.
    const port = createPort(PORT_NAMES.offscreen, {
      id: EXTENSION_ID,
      url: `${OFFSCREEN_URL}#spoofed`
    });

    router.handlePortConnect(port);

    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(portRegistry.getOffscreenPort()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] refused an offscreen port from another context",
      expect.anything()
    );
    warn.mockRestore();
  });

  it("rejects an offscreen-named port from an extension page as untrusted", () => {
    const { router, portRegistry } = createHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port = createPort(PORT_NAMES.offscreen, {
      id: EXTENSION_ID,
      url: `${EXTENSION_ORIGIN}/popup.html`
    });

    router.handlePortConnect(port);

    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(portRegistry.getOffscreenPort()).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] rejected port from untrusted sender",
      expect.objectContaining({ portName: PORT_NAMES.offscreen })
    );
    warn.mockRestore();
  });

  it("ignores ports with unknown names", () => {
    const { router, portRegistry } = createHarness();
    const port = createPort("some-other-port", extensionPageSender());

    router.handlePortConnect(port);

    expect(port.disconnect).not.toHaveBeenCalled();
    expect(portRegistry.hasPort(port)).toBe(false);
  });

  it("treats every sender as untrusted without an extension runtime", () => {
    const { router, sendResponse } = createHarness({ runtime: undefined });

    const handled = router.handleRuntimeMessage(
      { kind: "ui.stop", tabId: 7 },
      extensionPageSender(),
      sendResponse
    );

    expect(handled).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("ignores unparseable runtime messages", () => {
    const { router, sendResponse } = createHarness();

    expect(router.handleRuntimeMessage(null, extensionPageSender(), sendResponse)).toBe(false);
    expect(router.handleRuntimeMessage([1, 2], extensionPageSender(), sendResponse)).toBe(false);
    expect(router.handleRuntimeMessage({ noKind: true }, extensionPageSender(), sendResponse)).toBe(
      false
    );
  });
});

describe("inbound kind gating", () => {
  it("forbids content.* kinds from extension pages", async () => {
    const { router, deps, sendResponse } = createHarness();

    const handled = router.handleRuntimeMessage(
      { kind: "content.events", events: [{ source: "content", rawType: "click" }] },
      extensionPageSender(),
      sendResponse
    );

    expect(handled).toBe(false);
    await flushMicrotasks();
    expect(deps.ingestRawEvent).not.toHaveBeenCalled();
  });

  it("allows ui.* kinds from content senders (the e2e harness drives sessions from pages)", async () => {
    const { router, deps, sendResponse } = createHarness();

    const handled = router.handleRuntimeMessage(
      { kind: "ui.stop", tabId: 7 },
      contentSender(),
      sendResponse
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => {
      expect(deps.sessionCommands.stopSession).toHaveBeenCalledWith(7);
    });
  });

  it("forbids ui.* kinds on a content port from an untrusted frame", () => {
    const { router, deps } = createHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A content port whose sender has no tab cannot be classified as a content script.
    const port = createPort(PORT_NAMES.content, { id: EXTENSION_ID, url: "https://page.test/" });

    router.handlePortConnect(port);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(deps.ingestRawEvent).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("dispatch of inbound message kinds", () => {
  it("ui.start resolves the tab and starts the session with the message options", async () => {
    const { router, deps, sendResponse } = createHarness();

    router.handleRuntimeMessage(
      {
        kind: "ui.start",
        tabId: 7,
        mode: "full",
        visualCapture: "none",
        profileId: "p-1",
        reloadPage: true
      },
      extensionPageSender(),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(deps.sessionCommands.startSession).toHaveBeenCalledWith(7, "full", {
        visualCapture: "none",
        profileId: "p-1"
      });
    });
    await vi.waitFor(() => {
      expect(deps.sessionCommands.reloadRecordingTab).toHaveBeenCalledWith(7);
    });
    // The resolved engine is the one-shot response: ui.start returns nothing, so the
    // listener's default acknowledgement answers.
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("ui.start does nothing when no tab resolves", async () => {
    const { router, deps, sendResponse } = createHarness({
      resolveUiActionTarget: vi.fn(async () => undefined)
    });

    router.handleRuntimeMessage(
      { kind: "ui.start", mode: "lite" },
      extensionPageSender(),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalled();
    });
    expect(deps.sessionCommands.startSession).not.toHaveBeenCalled();
  });

  it("a failed start answers with ok:false and logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness();
    vi.mocked(harness.deps.sessionCommands.startSession).mockRejectedValue(new Error("denied"));

    harness.router.handleRuntimeMessage(
      { kind: "ui.start", tabId: 7, mode: "lite" },
      extensionPageSender(),
      harness.sendResponse
    );

    await vi.waitFor(() => {
      expect(harness.sendResponse).toHaveBeenCalledWith({ ok: false, error: "denied" });
    });
    expect(warn).toHaveBeenCalledWith(
      "[WebBlackbox] inbound message failed",
      expect.objectContaining({ kind: "ui.start" })
    );
    warn.mockRestore();
  });

  it("ui.export delegates to the export controller with the resolved policy", async () => {
    const { router, deps, sendResponse } = createHarness();
    const policy = { includeScreenshots: false };
    vi.mocked(deps.sessionExport.resolveExportPolicy).mockReturnValue(policy as never);

    router.handleRuntimeMessage(
      { kind: "ui.export", sid: "S-1", passphrase: "secret", saveAs: false, policy: {} },
      extensionPageSender(),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(deps.sessionExport.exportSession).toHaveBeenCalledWith("S-1", "secret", false, policy);
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, fileName: "session.wbbx" });
  });

  it("ui.delete and ui.annotate reach the session commands and annotations", async () => {
    const { router, deps, sendResponse } = createHarness();

    router.handleRuntimeMessage(
      { kind: "ui.delete", sid: "S-1" },
      extensionPageSender(),
      sendResponse
    );
    await vi.waitFor(() => {
      expect(deps.sessionCommands.deleteSessionBySid).toHaveBeenCalledWith("S-1");
    });

    router.handleRuntimeMessage(
      { kind: "ui.annotate", sid: "S-1", tags: ["bug"], note: "n" },
      extensionPageSender(),
      sendResponse
    );
    await vi.waitFor(() => {
      expect(deps.annotations.update).toHaveBeenCalledWith("S-1", ["bug"], "n");
    });
  });

  it("ui.ack-profile-cancel reaches the session commands", async () => {
    const { router, deps, sendResponse } = createHarness();

    router.handleRuntimeMessage(
      { kind: "ui.ack-profile-cancel", sid: "S-1" },
      extensionPageSender(),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(deps.sessionCommands.acknowledgeProfileCancel).toHaveBeenCalledWith("S-1");
    });
  });

  it("ui.request-session-list answers the one-shot message with the list", async () => {
    const { router, deps, sendResponse } = createHarness();

    router.handleRuntimeMessage(
      { kind: "ui.request-session-list" },
      extensionPageSender(),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ kind: "sw.session-list", sessions: [] });
    });
    expect(deps.sessionList.buildSessionListMessage).toHaveBeenCalledOnce();
  });

  it("ui.request-session-list on a port is answered on that port", async () => {
    const { router, deps } = createHarness();
    const port = createPort(PORT_NAMES.popup, extensionPageSender());

    router.handlePortConnect(port);
    port.emitMessage({ kind: "ui.request-session-list" });

    await vi.waitFor(() => {
      expect(port.sent).toEqual([{ kind: "sw.session-list", sessions: [] }]);
    });
    expect(deps.sessionList.buildSessionListMessage).toHaveBeenCalledOnce();
  });

  it("content.marker ingests a marker event for the sender's tab and frame", async () => {
    const { router, deps, sessionRegistry, sendResponse } = createHarness();
    const runtime = createRuntime();
    sessionRegistry.register(runtime);

    router.handleRuntimeMessage(
      { kind: "content.marker", message: "here" },
      contentSender(7, 3),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(deps.ingestRawEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "content",
          rawType: "marker",
          tabId: 7,
          sid: "S-1",
          frame: "content-frame-3",
          payload: { message: "here" }
        })
      );
    });
  });

  it("content.ready without a recording answers inactive", async () => {
    const { router, sendResponse } = createHarness();

    router.handleRuntimeMessage({ kind: "content.ready" }, contentSender(), sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ kind: "sw.recording-status", active: false });
    });
  });

  it("content.ready during a recording injects the hooks and answers with the status", async () => {
    const { router, deps, sessionRegistry, sendResponse } = createHarness();
    const runtime = createRuntime();
    sessionRegistry.register(runtime);

    router.handleRuntimeMessage({ kind: "content.ready" }, contentSender(7, 2), sendResponse);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "sw.recording-status",
          active: true,
          sid: "S-1",
          mode: "lite",
          injectedBridgeNonce: runtime.injectedBridgeNonce
        })
      );
    });
    expect(deps.scripting?.executeScript).toHaveBeenCalled();
  });

  it("content.stop-drained marks the stop-drain ack", async () => {
    const { router, sessionRegistry, stopDrain, sendResponse } = createHarness();
    const runtime = createRuntime();
    sessionRegistry.register(runtime);
    const ack = stopDrain.createStopDrainAck(runtime);

    router.handleRuntimeMessage(
      { kind: "content.stop-drained", sid: "S-1" },
      contentSender(),
      sendResponse
    );

    await expect(ack).resolves.toBeUndefined();
  });

  it("content.events ingests every event with the sender's tab and frame", async () => {
    const { router, deps, stopDrain, sendResponse } = createHarness();
    const events = [
      { source: "content", rawType: "click", sid: "S-1", t: 1, mono: 1, payload: {} },
      { source: "content", rawType: "scroll", sid: "S-1", t: 2, mono: 2, payload: {}, frame: "f" }
    ];

    router.handleRuntimeMessage(
      { kind: "content.events", events },
      contentSender(7, 4),
      sendResponse
    );

    await vi.waitFor(() => {
      expect(deps.ingestRawEvent).toHaveBeenCalledTimes(2);
    });
    expect(deps.ingestRawEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tabId: 7, frame: "content-frame-4" })
    );
    expect(deps.ingestRawEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tabId: 7, frame: "f" })
    );
    // The in-flight counter always returns to zero.
    expect(stopDrain.inFlightContentMessages(7)).toBe(0);
  });

  it("content.events without a tab or with an empty batch is dropped", async () => {
    const { router, deps, sendResponse } = createHarness();

    router.handleRuntimeMessage(
      { kind: "content.events", events: [] },
      contentSender(),
      sendResponse
    );
    await flushMicrotasks();
    expect(deps.ingestRawEvent).not.toHaveBeenCalled();
  });
});

describe("content port lifecycle", () => {
  it("connects, syncs the recording state to the port and pushes the session list", async () => {
    const { router, deps, portRegistry, sessionRegistry } = createHarness();
    const runtime = createRuntime();
    sessionRegistry.register(runtime);
    const port = createPort(PORT_NAMES.content, contentSender());

    router.handlePortConnect(port);

    expect(portRegistry.hasPort(port)).toBe(true);
    expect(deps.pushSessionList).toHaveBeenCalledOnce();

    await vi.waitFor(() => {
      expect(port.sent).toEqual([
        expect.objectContaining({
          kind: "sw.recording-status",
          active: true,
          sid: "S-1",
          injectedBridgeNonce: runtime.injectedBridgeNonce
        })
      ]);
    });
  });

  it("does not sync a tab without a recording", async () => {
    const { router } = createHarness();
    const port = createPort(PORT_NAMES.content, contentSender());

    router.handlePortConnect(port);
    await flushMicrotasks();

    expect(port.sent).toEqual([]);
  });

  it("forgets the port on disconnect", () => {
    const { router, portRegistry } = createHarness();
    const port = createPort(PORT_NAMES.popup, extensionPageSender());

    router.handlePortConnect(port);
    port.emitDisconnect();

    expect(portRegistry.hasPort(port)).toBe(false);
  });
});

describe("offscreen port routing", () => {
  it("accepts the offscreen document's port, sends the key and the pipeline status", async () => {
    const { router, deps, portRegistry } = createHarness();
    const port = createPort(PORT_NAMES.offscreen, offscreenSender());

    router.handlePortConnect(port);

    expect(portRegistry.getOffscreenPort()).toBe(port);
    expect(deps.sendAtRestKeyToOffscreen).toHaveBeenCalledWith(port);
    expect(deps.offscreenClient.post).toHaveBeenCalledWith(
      port,
      expect.objectContaining({ kind: "sw.pipeline-status", activeSessions: 0 })
    );
    await flushMicrotasks();
  });

  it("routes offscreen port messages to the offscreen client, never to the inbound handlers", async () => {
    const { router, deps } = createHarness();
    const readyMessage: OffscreenEventMessage = { kind: "offscreen.ready", t: 1 };
    vi.mocked(deps.offscreenClient.receive).mockReturnValue(readyMessage);
    const port = createPort(PORT_NAMES.offscreen, offscreenSender());
    vi.mocked(deps.offscreenClient.post).mockClear();

    router.handlePortConnect(port);
    port.emitMessage({ kind: "ui.stop", tabId: 7 });
    await flushMicrotasks();

    expect(deps.offscreenClient.receive).toHaveBeenCalledWith({ kind: "ui.stop", tabId: 7 });
    // offscreen.ready re-published the pipeline status instead of dispatching ui.stop.
    expect(deps.sessionCommands.stopSession).not.toHaveBeenCalled();
    expect(deps.offscreenClient.post).toHaveBeenCalledWith(
      port,
      expect.objectContaining({ kind: "sw.pipeline-status" })
    );
  });

  it("forwards screen recording events to the screen recording controller", async () => {
    const { router, deps } = createHarness();
    const chunk = {
      kind: "offscreen.screen-recording-chunk",
      sid: "S-1",
      recordingId: "R-1",
      chunk: "AAAA",
      index: 0
    } as unknown as OffscreenEventMessage;
    vi.mocked(deps.offscreenClient.receive).mockReturnValue(chunk);
    const port = createPort(PORT_NAMES.offscreen, offscreenSender());

    router.handlePortConnect(port);
    port.emitMessage({ raw: true });

    expect(deps.screenRecording.handleOffscreenScreenRecordingChunk).toHaveBeenCalledWith(chunk);
  });

  it("rejects pending requests and recovers sessions when the offscreen port drops", async () => {
    const { router, deps, sessionRegistry } = createHarness();
    sessionRegistry.register(createRuntime());
    const port = createPort(PORT_NAMES.offscreen, offscreenSender());

    router.handlePortConnect(port);
    port.emitDisconnect();
    await flushMicrotasks();

    expect(deps.offscreenClient.rejectPending).toHaveBeenCalledWith(
      "Offscreen pipeline disconnected."
    );
    expect(deps.markStoppedPipelinesDetached).toHaveBeenCalledOnce();
    expect(deps.recoverActiveOffscreenPipelines).toHaveBeenCalledOnce();
  });

  it("does not recover anything when the offscreen port drops with no active recordings", async () => {
    const { router, deps } = createHarness();
    const port = createPort(PORT_NAMES.offscreen, offscreenSender());

    router.handlePortConnect(port);
    port.emitDisconnect();
    await flushMicrotasks();

    expect(deps.recoverActiveOffscreenPipelines).not.toHaveBeenCalled();
  });

  it("drops the offscreen port when posting the pipeline status fails", () => {
    const { router, deps, portRegistry } = createHarness();
    const port = createPort(PORT_NAMES.offscreen, offscreenSender());

    router.handlePortConnect(port);
    vi.mocked(deps.offscreenClient.post).mockImplementation(() => {
      throw new Error("gone");
    });

    router.notifyOffscreenPipelineStatus();

    expect(portRegistry.getOffscreenPort()).toBeNull();
    expect(portRegistry.hasPort(port)).toBe(false);
  });
});

describe("relayMarkerCommand", () => {
  it("sends the marker command to the active tab of the current window", async () => {
    const { router, deps } = createHarness();

    await router.relayMarkerCommand();

    expect(deps.tabs?.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(deps.tabs?.sendMessage).toHaveBeenCalledWith(7, { kind: "sw.marker-command" });
  });

  it("does nothing without an active tab", async () => {
    const { router, deps } = createHarness();
    vi.mocked(deps.tabs!.query).mockResolvedValue([]);

    await router.relayMarkerCommand();

    expect(deps.tabs?.sendMessage).not.toHaveBeenCalled();
  });
});
