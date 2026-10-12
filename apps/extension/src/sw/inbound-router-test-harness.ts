/**
 * Test support for the inbound router: fake ports, senders, runtimes and a harness wiring them
 * into the router.
 */
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { vi, type Mock } from "vitest";

import type { PortLike, RuntimeMessageSender } from "../shared/chrome-api.js";
import { normalizeEnterprisePolicy } from "../shared/options-storage.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { createExportPassphraseStore } from "./export-passphrase.js";
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

export const EXTENSION_ID = "ext-id";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const OFFSCREEN_URL = `${EXTENSION_ORIGIN}/offscreen.html`;

export type FakePort = PortLike & {
  sent: unknown[];
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitMessage: (message: unknown) => void;
  emitDisconnect: () => void;
};

export function createPort(name: string, sender?: RuntimeMessageSender): FakePort {
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

export function contentSender(tabId = 7, frameId = 0): RuntimeMessageSender {
  return { id: EXTENSION_ID, url: "https://page.test/app", tab: { id: tabId }, frameId };
}

export function extensionPageSender(): RuntimeMessageSender {
  return { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}/popup.html` };
}

export function offscreenSender(): RuntimeMessageSender {
  return { id: EXTENSION_ID, url: OFFSCREEN_URL };
}

export function createPipelineStub(): SessionPipelineClient {
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

export function createRuntime(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntime {
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

export type Harness = {
  router: InboundRouter;
  portRegistry: PortRegistry;
  stopDrain: StopDrainTracker;
  sessionRegistry: ReturnType<typeof createSessionRegistry>;
  deps: InboundRouterDeps;
  sendResponse: Mock<(response: unknown) => void>;
};

export function createHarness(overrides: Partial<InboundRouterDeps> = {}): Harness {
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
      handleDebuggerDetach: vi.fn(async () => undefined),
      dismissExportPrompt: vi.fn(async () => undefined),
      markExported: vi.fn(async () => undefined),
      setIdleBadge: vi.fn(async () => undefined),
      setRecordingBadge: vi.fn(async () => undefined),
      setFreezeBadge: vi.fn(async () => undefined),
      refreshActionBadge: vi.fn(async () => undefined),
      refreshNoticeBadge: vi.fn(async () => undefined),
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
    passphrases: createExportPassphraseStore(undefined),
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

export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
