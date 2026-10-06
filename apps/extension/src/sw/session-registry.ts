import type { CdpRouter } from "@webblackbox/cdp-router";
import {
  DEFAULT_RECORDER_CONFIG,
  type CaptureMode,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import { WebBlackboxRecorder, type createDefaultRecorderPlugins } from "@webblackbox/recorder";

import type { FullModeVisualCapture } from "../shared/messages.js";
import type { PerformanceBudgetConfig } from "../shared/performance-budget.js";
import type { ProfileSelection } from "../shared/profiles/resolve.js";
import { FullBodyCapture } from "./full-body-capture.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import type { ProfileCancellation } from "./profile-change.js";
import type { CapturedVisuals } from "./profile-runtime.js";
import type { RequestMetaEntry } from "./request-meta.js";
import {
  createConcurrencyLimiter,
  SOURCE_MAP_FETCH_CONCURRENCY,
  ScriptSourceMapTracker
} from "./source-maps.js";
import type { StoppedSessionSnapshot } from "./stopped-session-store.js";

/**
 * Recording profile bookkeeping for one session. A session records with one profile only: when
 * the effective profile changes after Start, the recording is cancelled (`cancellation`).
 */
export type SessionProfileState = {
  /** What Start asked for: a profile id or `auto` (site rules decide on every navigation). */
  request: string;
  visualCapture?: FullModeVisualCapture;
  selection: ProfileSelection;
  /** Recorder config the profile rendered to at Start, before enterprise policy. */
  profileConfig: typeof DEFAULT_RECORDER_CONFIG;
  /** Visual data the profile allowed; the export keeps what was captured. */
  visualsCaptured: CapturedVisuals;
  reevaluation: Promise<void>;
  /** Bumped on every re-evaluation request; one from an older request is dropped. */
  generation: number;
  /** Why the recording was stopped after its profile changed. */
  cancellation?: ProfileCancellation;
  /** The popup has shown the cancellation notice. */
  cancellationAcknowledged?: boolean;
};

export type SessionRuntime = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  profile: SessionProfileState;
  url: string;
  scopeOrigin: string | null;
  title?: string;
  tags: string[];
  note?: string;
  config: typeof DEFAULT_RECORDER_CONFIG;
  startedAt: number;
  stoppedAt?: number;
  /** Set once Stop received the page's last events; later page snapshots are dropped. */
  stopDrained?: boolean;
  /** Secret shared with the injected page hooks and the content script of this session. */
  injectedBridgeNonce: string;
  recorder: WebBlackboxRecorder;
  pipeline: SessionPipelineClient;
  cdpRouter: CdpRouter | null;
  enabledCdpSessions: Set<string>;
  /** Page URLs the tab showed while recording (memory only): cookie values are read for all. */
  visitedPageUrls: Set<string>;
  requestMeta: Map<string, RequestMetaEntry>;
  screenshotInterval: ReturnType<typeof setInterval> | null;
  screenRecording: ScreenRecordingRuntime | null;
  lastPointer: PointerState | null;
  lastViewport: ViewportState | null;
  lastActionScreenshotMono: number;
  lastIncidentCaptureAt: number;
  queueDepth: number;
  droppedBestEffortTasks: number;
  pipelineEventBuffer: WebBlackboxEvent[];
  pipelineFlushTimer: ReturnType<typeof setTimeout> | null;
  pipelineFlushQueued: boolean;
  stopping: boolean;
  /** Full-mode response bodies: a body or a recorded skip for every textual response. */
  fullBodyCapture: FullBodyCapture;
  /** CDP events wait here, in order, while a request body CDP left out is being read. */
  cdpIngestChain: Promise<void>;
  cdpIngestBacklog: number;
  capturedEventCount: number;
  capturedErrorCount: number;
  capturedSizeBytes: number;
  budgetAlertCount: number;
  performanceBudget: PerformanceBudgetConfig;
  networkBudgetSample: {
    total: number;
    failed: number;
  };
  lastFreezeNotices: Map<string, number>;
  lastBudgetBreachAt: Map<string, number>;
  queue: Promise<void>;
  removeCdpListeners: Array<() => void>;
  heapSnapshotCapture: HeapSnapshotCaptureState | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  scriptSourceMaps: ScriptSourceMapTracker;
  scriptSourceMapFetches: <T>(task: () => Promise<T>) => Promise<T>;
};

export type ScreenRecordingRuntime = {
  recordingId: string;
  source: "tab";
  startedAt: number;
  startedMono: number;
  mime: string;
  width?: number;
  height?: number;
  frameRate?: number;
  chunks: string[];
  chunkCount: number;
  sizeBytes: number;
  stopPromise: Promise<void> | null;
};

export type PointerState = {
  x: number;
  y: number;
  t: number;
  mono: number;
};

export type ViewportState = {
  width: number;
  height: number;
  dpr: number;
};

export type HeapSnapshotCaptureState = {
  chunks: string[];
  bytes: number;
  truncated: boolean;
};

export type SessionAnnotation = {
  tags: string[];
  note?: string;
};

/**
 * The live session indexes. A recording sits in both maps while it records; Stop drops only the
 * tab binding (its tab may navigate again) while the sid binding keeps the draining and then the
 * stopped recording reachable until it is purged.
 */
export type SessionRegistry = {
  /** Read-only views of both indexes, for collaborators that still take the maps. */
  readonly byTab: ReadonlyMap<number, SessionRuntime>;
  readonly bySid: ReadonlyMap<string, SessionRuntime>;
  getByTab(tabId: number): SessionRuntime | undefined;
  getBySid(sid: string): SessionRuntime | undefined;
  hasSid(sid: string): boolean;
  tabCount(): number;
  sidCount(): number;
  /** Binds the session under both indexes; an existing tab binding is replaced. */
  register(runtime: SessionRuntime): void;
  /** Binds only by sid: a restored stopped recording no longer owns its tab. */
  registerBySid(runtime: SessionRuntime): void;
  /** Drops the tab binding only; the sid binding survives for the stop drain. */
  unregisterTab(tabId: number): void;
  unregisterSid(sid: string): void;
  tabRuntimes(): IterableIterator<SessionRuntime>;
  sidRuntimes(): IterableIterator<SessionRuntime>;
};

export function createSessionRegistry(): SessionRegistry {
  const byTab = new Map<number, SessionRuntime>();
  const bySid = new Map<string, SessionRuntime>();

  return {
    byTab,
    bySid,
    getByTab: (tabId) => byTab.get(tabId),
    getBySid: (sid) => bySid.get(sid),
    hasSid: (sid) => bySid.has(sid),
    tabCount: () => byTab.size,
    sidCount: () => bySid.size,
    register: (runtime) => {
      byTab.set(runtime.tabId, runtime);
      bySid.set(runtime.sid, runtime);
    },
    registerBySid: (runtime) => {
      bySid.set(runtime.sid, runtime);
    },
    unregisterTab: (tabId) => {
      byTab.delete(tabId);
    },
    unregisterSid: (sid) => {
      bySid.delete(sid);
    },
    tabRuntimes: () => byTab.values(),
    sidRuntimes: () => bySid.values()
  };
}

export type SessionRuntimeInit = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  profile: Pick<
    SessionProfileState,
    | "request"
    | "visualCapture"
    | "selection"
    | "profileConfig"
    | "visualsCaptured"
    | "cancellation"
    | "cancellationAcknowledged"
  >;
  url: string;
  title?: string;
  annotation: SessionAnnotation;
  config: typeof DEFAULT_RECORDER_CONFIG;
  startedAt: number;
  stoppedAt?: number;
  pipeline: SessionPipelineClient;
  recorderPlugins: ReturnType<typeof createDefaultRecorderPlugins>;
  performanceBudget: PerformanceBudgetConfig;
  counters?: StoppedSessionSnapshot["counters"];
  /** Unsanitized URL of the recorded page at Start (memory only; cookie values are read for it). */
  pageUrl?: string;
};

/**
 * Body capture is wired by the caller: it reads the debugger, blob storage and event ingestion,
 * which live outside this module.
 */
export type SessionRuntimeDeps = {
  createFullBodyCapture: (getRuntime: () => SessionRuntime) => FullBodyCapture;
};

/** A session runtime with its capture state reset; Start wires its recorder afterwards. */
export function createSessionRuntime(
  init: SessionRuntimeInit,
  deps: SessionRuntimeDeps
): SessionRuntime {
  const runtime: SessionRuntime = {
    sid: init.sid,
    tabId: init.tabId,
    mode: init.mode,
    profile: {
      ...init.profile,
      reevaluation: Promise.resolve(),
      generation: 0
    },
    url: init.url,
    scopeOrigin: resolveUrlOrigin(init.url),
    title: init.title,
    tags: [...init.annotation.tags],
    note: init.annotation.note,
    config: init.config,
    startedAt: init.startedAt,
    stoppedAt: init.stoppedAt,
    injectedBridgeNonce: createInjectedBridgeNonce(),
    recorder: new WebBlackboxRecorder(
      {
        ...init.config,
        mode: init.mode
      },
      {},
      undefined,
      init.recorderPlugins
    ),
    pipeline: init.pipeline,
    cdpRouter: null,
    enabledCdpSessions: new Set<string>(),
    visitedPageUrls: new Set(rememberablePageUrl(init.pageUrl) ?? []),
    requestMeta: new Map(),
    screenshotInterval: null,
    screenRecording: null,
    lastPointer: null,
    lastViewport: null,
    lastActionScreenshotMono: Number.NEGATIVE_INFINITY,
    lastIncidentCaptureAt: Number.NEGATIVE_INFINITY,
    queueDepth: 0,
    droppedBestEffortTasks: 0,
    pipelineEventBuffer: [],
    pipelineFlushTimer: null,
    pipelineFlushQueued: false,
    stopping: false,
    // The callbacks read `runtime` only after the session started.
    fullBodyCapture: deps.createFullBodyCapture(() => runtime),
    cdpIngestChain: Promise.resolve(),
    cdpIngestBacklog: 0,
    capturedEventCount: init.counters?.eventCount ?? 0,
    capturedErrorCount: init.counters?.errorCount ?? 0,
    capturedSizeBytes: init.counters?.sizeBytes ?? 0,
    budgetAlertCount: init.counters?.budgetAlertCount ?? 0,
    performanceBudget: init.performanceBudget,
    networkBudgetSample: {
      total: 0,
      failed: 0
    },
    lastFreezeNotices: new Map<string, number>(),
    lastBudgetBreachAt: new Map<string, number>(),
    queue: Promise.resolve(),
    removeCdpListeners: [],
    heapSnapshotCapture: null,
    cleanupTimer: null,
    scriptSourceMaps: new ScriptSourceMapTracker(),
    scriptSourceMapFetches: createConcurrencyLimiter(SOURCE_MAP_FETCH_CONCURRENCY)
  };

  return runtime;
}

/** An http(s) page URL without its fragment, or null for other schemes. */
export function rememberablePageUrl(rawUrl: string | undefined): [string] | null {
  try {
    const url = new URL(rawUrl ?? "");
    url.hash = "";
    return url.protocol === "http:" || url.protocol === "https:" ? [url.href] : null;
  } catch {
    return null;
  }
}

export function resolveUrlOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

function createInjectedBridgeNonce(): string {
  return crypto.randomUUID();
}
