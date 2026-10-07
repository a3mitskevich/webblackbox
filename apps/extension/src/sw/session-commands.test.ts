import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeEnterprisePolicy } from "../shared/options-storage.js";
import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import { AUTO_PROFILE_ID, type ProfileSelection } from "../shared/profiles/resolve.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionCommands,
  type SessionCommandsController,
  type SessionCommandsDeps
} from "./session-commands.js";
import {
  createSessionRegistry,
  createSessionRuntime,
  type SessionRegistry,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";

const TAB_ID = 7;
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";

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
      tabId: TAB_ID,
      mode: "lite",
      profile: {
        request: AUTO_PROFILE_ID,
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

type StorageLocalStub = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  stored: Record<string, unknown>;
};

function createStorageLocal(initial: Record<string, unknown> = {}): StorageLocalStub {
  const stub: StorageLocalStub = {
    stored: { ...initial },
    get: vi.fn(async (key: string) =>
      key in stub.stored ? { [key]: stub.stored[key] } : ({} as Record<string, unknown>)
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      stub.stored = { ...stub.stored, ...items };
    })
  };

  return stub;
}

type Harness = {
  commands: SessionCommandsController;
  registry: SessionRegistry;
  deps: SessionCommandsDeps;
  storageLocal: StorageLocalStub;
  sendMessage: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  pushSessionList: ReturnType<typeof vi.fn>;
  annotationRemove: ReturnType<typeof vi.fn>;
};

function createHarness(
  options: { selection?: ProfileSelection; storage?: Record<string, unknown> } = {}
): Harness {
  const registry = createSessionRegistry();
  const storageLocal = createStorageLocal(options.storage);
  const sendMessage = vi.fn(async () => undefined);
  const broadcast = vi.fn();
  const pushSessionList = vi.fn();
  const annotationRemove = vi.fn(async () => false);
  const selection: ProfileSelection = options.selection ?? {
    profile: createDefaultProfile(),
    source: "default",
    extended: false
  };

  const deps: SessionCommandsDeps = {
    sessionRegistry: registry,
    annotations: {
      get: () => ({ tags: [] }),
      update: vi.fn(async () => undefined),
      remove: annotationRemove,
      load: vi.fn(async () => undefined)
    },
    stopDrain: {
      adjustInFlightContentMessages: vi.fn(),
      inFlightContentMessages: () => 0,
      createStopDrainAck: () => Promise.resolve(),
      markStopDrainAckReceived: vi.fn(),
      pendingStopDrainAckCount: () => 0
    } as unknown as SessionCommandsDeps["stopDrain"],
    pipelineBuffer: {
      enqueuePipelineEvent: vi.fn(),
      flushBufferedPipelineEvents: vi.fn(async () => undefined)
    },
    profile: {
      loadSessionProfilesState: vi.fn(),
      loadEnterprisePolicy: vi.fn(async () => normalizeEnterprisePolicy({})),
      resolveTabProfileSelection: vi.fn(async () => selection),
      resolveProfilePreview: vi.fn(),
      scheduleProfileReevaluation: vi.fn()
    } as unknown as SessionCommandsDeps["profile"],
    fullCdp: {
      attachCdp: vi.fn(async () => undefined),
      createFullBodyCapture: () => createFullBodyCaptureStub(),
      cleanupCdpInstrumentation: vi.fn(async () => undefined)
    } as unknown as SessionCommandsDeps["fullCdp"],
    screenRecording: {
      shouldStartScreenRecording: () => false,
      startScreenRecording: vi.fn(async () => undefined),
      stopScreenRecording: vi.fn(async () => undefined)
    } as unknown as SessionCommandsDeps["screenRecording"],
    storageArtifacts: {
      captureCookieValues: vi.fn(async () => undefined)
    } as unknown as SessionCommandsDeps["storageArtifacts"],
    liteNetworkBaseline: { install: vi.fn(), uninstallIfUnused: vi.fn() },
    recordedTabWatch: { sync: vi.fn(), isWatching: () => false },
    tabsContextTracker: null,
    stoppedSessionLifecycle: {
      scheduleStoppedRuntimeCleanup: vi.fn(),
      rememberStoppedSessionRecord: vi.fn(async () => undefined),
      rememberStoppedSession: vi.fn(async () => undefined),
      disposeStoppedSession: vi.fn(async () => undefined),
      restoreStoppedSessions: vi.fn(async () => undefined),
      sweepStalePipelineSessions: vi.fn(async () => undefined)
    } as unknown as SessionCommandsDeps["stoppedSessionLifecycle"],
    tabs: {
      get: vi.fn(async () => ({ id: TAB_ID, url: "https://example.test/app", title: "Example" })),
      reload: vi.fn(async () => undefined),
      sendMessage
    } as unknown as SessionCommandsDeps["tabs"],
    scripting: undefined,
    action: undefined,
    storageLocal: storageLocal as unknown as SessionCommandsDeps["storageLocal"],
    broadcast,
    notifyOffscreenPipelineStatus: vi.fn(),
    pushSessionList,
    scheduleSessionListPush: vi.fn(),
    ingestRawEvent: vi.fn(),
    enqueueWithResult: (_runtime, task) => task(),
    updateSessionMetadataFromEvent: vi.fn(),
    handleFreezeNotice: vi.fn(),
    getAtRestKey: vi.fn(
      async () => ({}) as Awaited<ReturnType<SessionCommandsDeps["getAtRestKey"]>>
    ),
    ensureOffscreenDocument: vi.fn(async () => undefined),
    createPipeline: () => createPipelineStub(),
    loadPerformanceBudgetConfig: vi.fn(async () => ({ ...DEFAULT_PERFORMANCE_BUDGET })),
    monotonicTime: () => 0
  };

  return {
    commands: createSessionCommands(deps),
    registry,
    deps,
    storageLocal,
    sendMessage,
    broadcast,
    pushSessionList,
    annotationRemove
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startSession", () => {
  it("keeps an explicit profile choice as the session's profile request", async () => {
    const profile = createDefaultProfile();
    const harness = createHarness({
      selection: { profile, source: "explicit", extended: false }
    });

    await harness.commands.startSession(TAB_ID, "lite", { profileId: profile.id });

    expect(harness.registry.getByTab(TAB_ID)?.profile.request).toBe(profile.id);
  });

  it("re-runs later checks as auto when the requested profile no longer existed at Start", async () => {
    // A stale popup choice: the profile was deleted, so the rules/default picked another one.
    const harness = createHarness({
      selection: { profile: createDefaultProfile(), source: "default", extended: false }
    });

    await harness.commands.startSession(TAB_ID, "lite", { profileId: "user-deleted" });

    expect(harness.deps.profile.resolveTabProfileSelection).toHaveBeenCalledWith(
      TAB_ID,
      "user-deleted"
    );
    expect(harness.registry.getByTab(TAB_ID)?.profile.request).toBe(AUTO_PROFILE_ID);
  });

  it("registers the runtime, tells the tab and persists the active session", async () => {
    const harness = createHarness();

    const mode = await harness.commands.startSession(TAB_ID, "lite");
    const runtime = harness.registry.getByTab(TAB_ID);

    expect(mode).toBe("lite");
    expect(runtime).toBeDefined();
    expect(harness.deps.recordedTabWatch.sync).toHaveBeenCalledWith(true);
    expect(harness.deps.liteNetworkBaseline.install).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ kind: "sw.recording-status", active: true, sid: runtime?.sid })
    );
    expect(harness.storageLocal.stored[ACTIVE_SESSION_STORAGE_KEY]).toEqual([
      expect.objectContaining({ tabId: TAB_ID, sid: runtime?.sid, mode: "lite" })
    ]);
  });
});

describe("stopSession", () => {
  it("unregisters the tab, remembers the stopped session and reports it inactive", async () => {
    const harness = createHarness();
    await harness.commands.startSession(TAB_ID, "lite");
    const runtime = harness.registry.getByTab(TAB_ID) as SessionRuntime;

    await harness.commands.stopSession(TAB_ID);

    expect(harness.registry.getByTab(TAB_ID)).toBeUndefined();
    expect(runtime.stoppedAt).toEqual(expect.any(Number));
    expect(runtime.stopDrained).toBe(true);
    expect(harness.deps.stoppedSessionLifecycle.rememberStoppedSession).toHaveBeenCalledTimes(2);
    expect(harness.broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "sw.recording-status", active: false, sid: runtime.sid })
    );
    expect(harness.storageLocal.stored[ACTIVE_SESSION_STORAGE_KEY]).toEqual([]);
  });

  it("ignores a tab that is not recording or already stopping", async () => {
    const harness = createHarness();
    const runtime = createRuntime();
    runtime.stopping = true;
    harness.registry.register(runtime);

    await harness.commands.stopSession(TAB_ID);
    await harness.commands.stopSession(99);

    expect(harness.registry.getByTab(TAB_ID)).toBe(runtime);
    expect(harness.broadcast).not.toHaveBeenCalled();
  });
});

describe("deleteSessionBySid", () => {
  it("only forgets the annotation of an unknown session", async () => {
    const harness = createHarness();

    await harness.commands.deleteSessionBySid("S-unknown");

    expect(harness.annotationRemove).toHaveBeenCalledWith("S-unknown");
    expect(harness.deps.stoppedSessionLifecycle.disposeStoppedSession).not.toHaveBeenCalled();
    expect(harness.pushSessionList).not.toHaveBeenCalled();
  });

  it("disposes a stopped session and pushes the list when it had an annotation", async () => {
    const harness = createHarness();
    const runtime = createRuntime();
    runtime.stoppedAt = 2_000;
    harness.registry.register(runtime);
    harness.annotationRemove.mockResolvedValueOnce(true);

    await harness.commands.deleteSessionBySid(runtime.sid);

    expect(harness.deps.stoppedSessionLifecycle.disposeStoppedSession).toHaveBeenCalledWith(
      runtime
    );
    expect(harness.pushSessionList).toHaveBeenCalledTimes(1);
  });
});

describe("restoreRuntimeState", () => {
  it("clears sessions a dead worker left active and tells their tabs they stopped", async () => {
    const harness = createHarness({
      storage: { [ACTIVE_SESSION_STORAGE_KEY]: [{ tabId: TAB_ID, sid: "S-old", mode: "lite" }] }
    });

    await harness.commands.restoreRuntimeState();

    expect(harness.storageLocal.stored[ACTIVE_SESSION_STORAGE_KEY]).toEqual([]);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ kind: "sw.recording-status", active: false })
    );
    expect(harness.deps.stoppedSessionLifecycle.restoreStoppedSessions).toHaveBeenCalledTimes(1);
    expect(harness.pushSessionList).toHaveBeenCalledTimes(1);
  });
});
