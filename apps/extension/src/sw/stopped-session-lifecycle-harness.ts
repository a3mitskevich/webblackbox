/**
 * Test support for the stopped-session lifecycle: JSON-backed fake storage areas, alarms,
 * pipeline stubs, runtimes, snapshots and a harness wiring them into the lifecycle.
 */
import type { PipelineSessionSweepResult } from "@webblackbox/pipeline/storage";
import { DEFAULT_RECORDER_CONFIG } from "@webblackbox/protocol";
import { createDefaultRecorderPlugins } from "@webblackbox/recorder";
import { vi } from "vitest";

import { DEFAULT_PERFORMANCE_BUDGET } from "../shared/performance-budget.js";
import type { RecordingProfile } from "../shared/profiles/model.js";
import { createDefaultProfile } from "../shared/profiles/presets.js";
import { FullBodyCapture } from "./full-body-capture.js";
import { LIVE_SESSION_SNAPSHOTS_KEY, type LiveSessionSnapshot } from "./live-session-store.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import {
  createSessionRegistry,
  createSessionRuntime,
  type SessionRegistry,
  type SessionRuntime,
  type SessionRuntimeInit
} from "./session-registry.js";
import {
  createStoppedSessionLifecycle,
  type StoppedSessionLifecycleController,
  type StoppedSessionLifecycleDeps
} from "./stopped-session-lifecycle.js";
import type {
  RetentionAlarmsLike,
  SnapshotStorageAreaLike,
  StoppedSessionSnapshot
} from "./stopped-session-store.js";
import { STOPPED_SESSIONS_STORAGE_KEY, type StoppedSessionRecord } from "./stopped-sessions.js";

export type FakeArea = SnapshotStorageAreaLike & {
  read: (key: string) => unknown;
};

/** Stores JSON, as `chrome.storage.session` / `chrome.storage.local` do. */
export function createArea(options: { delayed?: boolean } = {}): FakeArea {
  let stored: Record<string, string> = {};
  const tick = (): Promise<void> =>
    options.delayed ? new Promise<void>((resolve) => setTimeout(resolve, 0)) : Promise.resolve();

  return {
    get: vi.fn(async (key: string) => {
      await tick();
      const value = stored[key];
      return value === undefined ? {} : { [key]: JSON.parse(value) as unknown };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await tick();
      stored = {
        ...stored,
        ...Object.fromEntries(
          Object.entries(items).map(([key, value]) => [key, JSON.stringify(value)])
        )
      };
    }),
    read: (key: string) =>
      stored[key] === undefined ? undefined : (JSON.parse(stored[key]) as unknown)
  };
}

export type FakeAlarms = RetentionAlarmsLike & {
  create: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};

export function createAlarms(): FakeAlarms {
  return {
    create: vi.fn(() => undefined),
    clear: vi.fn(async () => true)
  };
}

export type PipelineStub = SessionPipelineClient & {
  start: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

export function createPipelineStub(overrides: Partial<SessionPipelineClient> = {}): PipelineStub {
  const stub: PipelineStub = {
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

  return Object.assign(stub, overrides);
}

export function createFullBodyCaptureStub(): FullBodyCapture {
  return new FullBodyCapture({
    isEnabled: () => false,
    resolveRule: () => ({ enabled: false, maxBytes: 0, mimeAllowlist: [] }),
    readResponseBody: () => Promise.resolve({ ok: false, error: "unavailable" }),
    storeBody: () => Promise.resolve(0),
    emitSkip: () => undefined
  });
}

/** Minutes the harness profile keeps an unexported recording (the pre-task-61 default). */
const HARNESS_RETENTION_MINUTES = 10;
export const HARNESS_RETENTION_MS = HARNESS_RETENTION_MINUTES * 60_000;

/** A profile with a retention timer; the built-in profiles keep recordings until exported. */
export function timedRetentionProfile(): RecordingProfile {
  return {
    ...createDefaultProfile(),
    localData: { deleteAfterExport: true, unexportedRetentionMinutes: HARNESS_RETENTION_MINUTES }
  };
}

export function createRuntimeInit(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntimeInit {
  return {
    sid: "S-1",
    tabId: 7,
    mode: "lite",
    profile: {
      request: "auto",
      selection: { profile: timedRetentionProfile(), source: "default", extended: false },
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
  };
}

export function createRuntime(overrides: Partial<SessionRuntimeInit> = {}): SessionRuntime {
  return createSessionRuntime(createRuntimeInit(overrides), {
    createFullBodyCapture: () => createFullBodyCaptureStub()
  });
}

export function snapshot(
  sid: string,
  overrides: Partial<StoppedSessionSnapshot> = {}
): StoppedSessionSnapshot {
  return {
    sid,
    tabId: 7,
    mode: "lite",
    startedAt: 1_000,
    stoppedAt: 2_000,
    expiresAt: 302_000,
    url: "https://example.test/app",
    title: "Example",
    profile: {
      request: "auto",
      selection: { profile: timedRetentionProfile(), source: "default", extended: false },
      profileConfig: DEFAULT_RECORDER_CONFIG,
      visualsCaptured: { screenshots: true, screenRecordings: false }
    },
    config: DEFAULT_RECORDER_CONFIG,
    counters: { eventCount: 12, errorCount: 1, sizeBytes: 4_096, budgetAlertCount: 2 },
    purgeAttempts: 0,
    ...overrides
  };
}

export function seedSnapshots(area: FakeArea, snapshots: StoppedSessionSnapshot[]): void {
  void area.set({
    "webblackbox.atRest.stoppedSessions": JSON.parse(JSON.stringify(snapshots)) as unknown
  });
}

export function storedSnapshots(area: FakeArea): StoppedSessionSnapshot[] {
  return (area.read("webblackbox.atRest.stoppedSessions") ?? []) as StoppedSessionSnapshot[];
}

export function storedLiveSnapshots(area: FakeArea): LiveSessionSnapshot[] {
  return (area.read(LIVE_SESSION_SNAPSHOTS_KEY) ?? []) as LiveSessionSnapshot[];
}

export function liveSnapshot(sid: string, lastSeenAt: number): LiveSessionSnapshot {
  const stopped = snapshot(sid);

  return {
    sid,
    tabId: stopped.tabId,
    mode: stopped.mode,
    startedAt: stopped.startedAt,
    url: stopped.url,
    title: stopped.title,
    profile: stopped.profile,
    config: stopped.config,
    counters: stopped.counters,
    lastSeenAt
  };
}

export function storedRecords(area: FakeArea): StoppedSessionRecord[] {
  return (area.read(STOPPED_SESSIONS_STORAGE_KEY) ?? []) as StoppedSessionRecord[];
}

export type Harness = {
  lifecycle: StoppedSessionLifecycleController;
  deps: StoppedSessionLifecycleDeps;
  registry: SessionRegistry;
  alarms: FakeAlarms;
  sessionArea: FakeArea;
  localArea: FakeArea;
  pipelines: Map<string, PipelineStub>;
  closeOffscreenDocument: ReturnType<typeof vi.fn>;
  flushBufferedPipelineEvents: ReturnType<typeof vi.fn>;
  refreshActionBadge: ReturnType<typeof vi.fn>;
  pushSessionList: ReturnType<typeof vi.fn>;
  persistRuntimeState: ReturnType<typeof vi.fn>;
  notifyOffscreenPipelineStatus: ReturnType<typeof vi.fn>;
  loadPerformanceBudgetConfig: ReturnType<typeof vi.fn>;
  getSessionAnnotation: ReturnType<typeof vi.fn>;
  sweepStoredSessions: ReturnType<typeof vi.fn>;
  getAtRestKey: ReturnType<typeof vi.fn>;
};

export function createHarness(overrides: Partial<StoppedSessionLifecycleDeps> = {}): Harness {
  const registry = createSessionRegistry();
  const alarms = createAlarms();
  const sessionArea = createArea();
  const localArea = createArea();
  const pipelines = new Map<string, PipelineStub>();
  const closeOffscreenDocument = vi.fn(async () => undefined);
  const flushBufferedPipelineEvents = vi.fn(async () => undefined);
  const refreshActionBadge = vi.fn(async () => undefined);
  const pushSessionList = vi.fn();
  const persistRuntimeState = vi.fn(async () => undefined);
  const notifyOffscreenPipelineStatus = vi.fn();
  const loadPerformanceBudgetConfig = vi.fn(async () => ({ ...DEFAULT_PERFORMANCE_BUDGET }));
  const getSessionAnnotation = vi.fn(() => ({ tags: [] as string[] }));
  const sweepStoredSessions = vi.fn(async (): Promise<PipelineSessionSweepResult> => ({
    deleted: [],
    failed: []
  }));
  const getAtRestKey = vi.fn(async () => ({}));

  const deps: StoppedSessionLifecycleDeps = {
    sessionRegistry: registry,
    alarms,
    sessionStorageArea: sessionArea,
    localStorageArea: localArea,
    closeOffscreenDocument,
    getAtRestKey,
    isAtRestKeyFresh: () => false,
    waitForRuntimeState: async () => undefined,
    loadPerformanceBudgetConfig,
    getSessionAnnotation,
    createPipeline: (sid) => {
      const existing = pipelines.get(sid);

      if (existing) {
        return existing;
      }

      const stub = createPipelineStub();
      pipelines.set(sid, stub);
      return stub;
    },
    createFullBodyCapture: () => createFullBodyCaptureStub(),
    toSessionMetadata: (runtime) => ({
      sid: runtime.sid,
      tabId: runtime.tabId,
      startedAt: runtime.startedAt,
      mode: runtime.mode,
      url: runtime.url,
      title: runtime.title,
      tags: [...runtime.tags]
    }),
    flushBufferedPipelineEvents,
    refreshActionBadge,
    pushSessionList,
    persistRuntimeState,
    notifyOffscreenPipelineStatus,
    indexedDB: undefined,
    sweepStoredSessions,
    bootedAt: 100_000,
    ...overrides
  };

  return {
    lifecycle: createStoppedSessionLifecycle(deps),
    deps,
    registry,
    alarms,
    sessionArea,
    localArea,
    pipelines,
    closeOffscreenDocument,
    flushBufferedPipelineEvents,
    refreshActionBadge,
    pushSessionList,
    persistRuntimeState,
    notifyOffscreenPipelineStatus,
    loadPerformanceBudgetConfig,
    getSessionAnnotation,
    sweepStoredSessions,
    getAtRestKey
  };
}

export function registerStopped(
  harness: Harness,
  overrides: Partial<SessionRuntimeInit> = {}
): SessionRuntime {
  const runtime = createRuntime({ stoppedAt: 2_000, ...overrides });
  harness.registry.registerBySid(runtime);
  return runtime;
}
