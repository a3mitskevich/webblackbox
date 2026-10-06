import { createCdpRouter, createChromeDebuggerTransport } from "@webblackbox/cdp-router";
import { IndexedDbPipelineStorage, sweepPipelineSessions } from "@webblackbox/pipeline/storage";
import { BODY_REDACTION_TOKEN } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import { PIPELINE_DB_NAME } from "../shared/at-rest.js";
import { getChromeApi, type PortLike } from "../shared/chrome-api.js";
import { CONTENT_INJECTION_STORAGE_KEY } from "../shared/content-injection.js";
import { OFFSCREEN_CONNECT_REQUEST_KIND } from "../shared/offscreen-messages.js";
import {
  normalizePerformanceBudget,
  PERFORMANCE_BUDGET_STORAGE_KEY,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";
import {
  createBoundedManagedPolicyReader,
  readManagedEnterprisePolicy
} from "../shared/options-storage.js";
import { migrateSettingsStorage } from "../shared/settings-migration.js";
import { createArtifactsController } from "./artifacts.js";
import { createScreenshotArtifactsController } from "./artifacts-screenshot.js";
import { createScreenRecordingController } from "./artifacts-screen-recording.js";
import { createStorageArtifactsController } from "./artifacts-storage.js";
import { createProfileArtifactsController } from "./artifacts-profiles.js";
import { bootstrapAtRestKey, toStorageKeyMessage, type AtRestKeyRecord } from "./at-rest-key.js";
import { createContentInjectionController } from "./content-injection.js";
import { createSessionExportController } from "./export-session.js";
import { createFullCdpController, readContentScriptRecord } from "./full-cdp.js";
import { createInboundRouter } from "./inbound-router.js";
import {
  materializeLiteContentEvent,
  shouldMaterializeLiteContentEvent
} from "./lite-materialize.js";
import { createLiteNetworkBaselineController } from "./lite-network.js";
import { createOffscreenClient, createSessionPipelineClient } from "./offscreen-client.js";
import { createOffscreenPortConnector } from "./offscreen-port.js";
import { createPipelineBuffer } from "./pipeline-buffer.js";
import { createPortRegistry } from "./port-registry.js";
import { createPortTrafficMeter } from "./port-traffic.js";
import { isProfileSettingsChange } from "./profile-change.js";
import { createProfileReevaluation } from "./profile-reevaluation.js";
import { createRecordedTabWatch } from "./recorded-tab-watch.js";
import { createSessionAnnotations } from "./session-annotations.js";
import { createSessionCommands } from "./session-commands.js";
import { createSessionListView, toSessionMetadata } from "./session-list.js";
import { createSessionRegistry, type SessionRuntime } from "./session-registry.js";
import { resolveRawEventSession } from "./session-routing.js";
import { SCRIPT_RAW_TYPE } from "./source-maps.js";
import { createStopDrainTracker, shouldAllowStopDrainContentEvent } from "./stop-drain.js";
import { sidFromRetentionAlarm } from "./stopped-session-store.js";
import {
  createStoppedSessionLifecycle,
  type StoppedSessionLifecycleController
} from "./stopped-session-lifecycle.js";
import { createThrottledPush } from "./throttled-push.js";
import { TabsContextTracker, type TabsContextEmission } from "./tabs-context/tracker.js";
import { resolveUiActionTabId } from "./ui-action-target.js";

const chromeApi = getChromeApi();

const sessionRegistry = createSessionRegistry();
const offscreenSessionRecovery = new Map<string, Promise<void>>();

const OFFSCREEN_PATH = "offscreen.html";
const SERVICE_WORKER_BOOTED_AT = Date.now();
const BEST_EFFORT_QUEUE_MAX_PENDING = 80;
/** Shortest gap between session-list pushes driven by recorded events (counters, errors). */
const SESSION_LIST_EVENT_PUSH_INTERVAL_MS = 500;
// Full mode's "what the page captures" decision is made once, at the source: the capture agent
// applies `shouldPageCapture` (webblackbox/capture-scope); events that arrive here are trusted.
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const OFFSCREEN_PORT_READY_TIMEOUT_MS = 5_000;
const OFFSCREEN_PORT_READY_WAIT_MS = 25;
// Chrome can hold `storage.managed` reads back while the browser starts; see the reader.
const ENTERPRISE_POLICY_READ_TIMEOUT_MS = 3_000;

const tabsContextTracker = createTabsContextTracker();

console.info("[WebBlackbox] service worker booted");

const contentInjection = createContentInjectionController(chromeApi);
const offscreenPortTraffic = createPortTrafficMeter();
const portRegistry = createPortRegistry({
  offscreenPortTraffic,
  shouldLogPortDebug
});
const stopDrain = createStopDrainTracker({
  getRuntimeBySid: (sid) => sessionRegistry.getBySid(sid)
});
const sessionListView = createSessionListView({
  sessionRegistry,
  broadcast: (message) => {
    portRegistry.broadcast(message);
  }
});
const pipelineBuffer = createPipelineBuffer({
  enqueue,
  enqueueWithResult,
  wait,
  shouldLogPerf
});
const sessionListPush = createThrottledPush(
  () => sessionListView.broadcastSessionList(),
  SESSION_LIST_EVENT_PUSH_INTERVAL_MS
);

function pushSessionList(): void {
  sessionListPush.now();
}

function resolveUiActionTarget(
  requestedTabId: number | undefined,
  senderTabId: number | undefined
): Promise<number | undefined> {
  return resolveUiActionTabId({
    requestedTabId,
    senderTabId,
    queryActiveTabId: async () => {
      const activeTabs =
        (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
      return activeTabs[0]?.id;
    },
    fallbackTabId: () => sessionRegistry.byTab.keys().next().value
  });
}

const recordedTabWatch = createRecordedTabWatch(chromeApi, {
  onTabUpdated: (tabId, changeInfo) => {
    inboundRouter.handleRecordedTabUpdated(tabId, changeInfo);
  },
  onTabRemoved: (tabId) => {
    void sessionCommands.stopSession(tabId);
  },
  onFrameCommitted: (details) => {
    inboundRouter.handleRecordedFrameCommitted(details);
  }
});
const screenshotArtifacts = createScreenshotArtifactsController({
  ingestRawEvent,
  bestEffortQueueMaxPending: BEST_EFFORT_QUEUE_MAX_PENDING
});
const screenRecording = createScreenRecordingController({
  tabCapture: chromeApi?.tabCapture,
  // The offscreen client is created below; recordings only start after a session does.
  getOffscreenClient: () => offscreenClient,
  getRuntimeBySid: (sid) => sessionRegistry.getBySid(sid),
  ingestRawEvent
});
const storageArtifacts = createStorageArtifactsController({ ingestRawEvent });
const profileArtifacts = createProfileArtifactsController({ ingestRawEvent, wait });
const artifacts = createArtifactsController({
  captureScreenshot: screenshotArtifacts.captureScreenshot,
  captureTraceMetrics: profileArtifacts.captureTraceMetrics,
  captureAdvancedProfiles: profileArtifacts.captureAdvancedProfiles,
  captureStorageSnapshots: storageArtifacts.captureStorageSnapshots,
  captureCookieValues: storageArtifacts.captureCookieValues,
  broadcast: (message) => {
    portRegistry.broadcast(message);
  },
  setFreezeBadge: () => sessionCommands.setFreezeBadge()
});
const fullCdp = createFullCdpController({
  createRouter: () => createCdpRouter(createChromeDebuggerTransport()),
  ingestRawEvent,
  enqueue,
  stopSession: (tabId) => sessionCommands.stopSession(tabId),
  captureFullModeArtifacts: artifacts.captureFullModeArtifacts,
  captureScreenshot: screenshotArtifacts.captureScreenshot,
  shouldCaptureIncidentArtifacts: artifacts.shouldCaptureIncidentArtifacts,
  captureIncidentArtifacts: artifacts.captureIncidentArtifacts,
  resolveBodyRule: (runtime, url, mimeType) =>
    sessionCommands.resolveFullBodyCaptureRule(runtime, url, mimeType),
  bodyRedactedToken: BODY_REDACTION_TOKEN
});
const liteNetworkBaseline = createLiteNetworkBaselineController({
  webRequest: chromeApi?.webRequest,
  ingestRawEvent,
  getRuntimeByTab: (tabId) => sessionRegistry.getByTab(tabId),
  tabRuntimes: () => sessionRegistry.tabRuntimes()
});
const offscreenPortConnector = createOffscreenPortConnector<PortLike>(
  {
    getPort: () => portRegistry.getOffscreenPort(),
    hasDocument: hasOffscreenDocument,
    createDocument: createOffscreenDocument,
    closeDocument: async () => {
      await chromeApi?.offscreen?.closeDocument();
    },
    requestReconnect: async () => {
      await chromeApi?.runtime?.sendMessage({ kind: OFFSCREEN_CONNECT_REQUEST_KIND });
    },
    wait
  },
  {
    portWaitMs: OFFSCREEN_PORT_READY_TIMEOUT_MS,
    pollMs: OFFSCREEN_PORT_READY_WAIT_MS
  }
);
const offscreenClient = createOffscreenClient({
  ensurePort: ensureOffscreenPortReady,
  recoverSession: recoverOffscreenSession,
  traffic: offscreenPortTraffic,
  shouldLogPerf
});
const readEnterprisePolicy = createBoundedManagedPolicyReader(
  () => readManagedEnterprisePolicy(chromeApi?.storage?.managed),
  {
    timeoutMs: ENTERPRISE_POLICY_READ_TIMEOUT_MS,
    onTimeout: () => {
      console.warn("[WebBlackbox] enterprise policy not available yet; continuing without it");
    }
  }
);
const orphanedOffscreenCleanup = closeOrphanedOffscreenDocument().catch((error) => {
  console.warn("[WebBlackbox] failed to close orphaned offscreen document", error);
});

let atRestKeyReady: Promise<AtRestKeyRecord> | null = null;
/** This worker minted the key: a new browser session, nothing stored before is readable. */
let atRestKeyMinted = false;

void getAtRestKey().catch((error) => {
  console.warn("[WebBlackbox] at-rest encryption key unavailable", error);
});
// v1 options move into the profiles store once; profile and budget reads wait for it.
const settingsMigrated = migrateSettingsStorage(chromeApi?.storage?.local).then((result) => {
  if (result.status === "failed") {
    console.warn(
      "[WebBlackbox] settings migration failed; retried at the next start",
      result.error
    );
  }
});

const annotations = createSessionAnnotations({
  sessionStorageArea: chromeApi?.storage?.session,
  localStorageArea: chromeApi?.storage?.local,
  getRuntimeBySid: (sid) => sessionRegistry.getBySid(sid),
  pushSessionList
});
const profileReevaluation = createProfileReevaluation({
  chromeApi,
  settingsMigrated,
  readEnterprisePolicy,
  resolveUiActionTarget,
  ingestRawEvent,
  stopSession: (tabId) => sessionCommands.stopSession(tabId),
  monotonicTime
});
const stoppedSessionLifecycle: StoppedSessionLifecycleController = createStoppedSessionLifecycle({
  sessionRegistry,
  alarms: chromeApi?.alarms,
  sessionStorageArea: chromeApi?.storage?.session,
  localStorageArea: chromeApi?.storage?.local,
  closeOffscreenDocument: async () => {
    await chromeApi?.offscreen?.closeDocument?.();
  },
  getAtRestKey,
  isAtRestKeyFresh: () => atRestKeyMinted,
  waitForRuntimeState: () => runtimeStateRestored,
  loadPerformanceBudgetConfig,
  getSessionAnnotation: (sid) => annotations.get(sid),
  createPipeline: (sid) => createSessionPipelineClient(offscreenClient, sid),
  createFullBodyCapture: fullCdp.createFullBodyCapture,
  toSessionMetadata,
  flushBufferedPipelineEvents: pipelineBuffer.flushBufferedPipelineEvents,
  refreshActionBadge: () => sessionCommands.refreshActionBadge(),
  pushSessionList,
  persistRuntimeState: () => sessionCommands.persistRuntimeState(),
  notifyOffscreenPipelineStatus: () => {
    inboundRouter.notifyOffscreenPipelineStatus();
  },
  indexedDB: globalThis.indexedDB,
  sweepStoredSessions: (shouldDelete) =>
    sweepPipelineSessions(new IndexedDbPipelineStorage(PIPELINE_DB_NAME), shouldDelete),
  bootedAt: SERVICE_WORKER_BOOTED_AT
});
const sessionExport = createSessionExportController({
  getRuntimeBySid: (sid) => sessionRegistry.getBySid(sid),
  stopSession: (tabId) => sessionCommands.stopSession(tabId),
  flushBufferedPipelineEvents: pipelineBuffer.flushBufferedPipelineEvents,
  attachStoppedPipeline: (runtime) => stoppedSessionLifecycle.attachStoppedPipeline(runtime),
  disposeStoppedSession: (runtime) => stoppedSessionLifecycle.disposeStoppedSession(runtime),
  enqueueWithResult,
  downloads: chromeApi?.downloads,
  auditStorageArea: chromeApi?.storage?.local,
  broadcast: (message) => {
    portRegistry.broadcast(message);
  }
});
const sessionCommands = createSessionCommands({
  sessionRegistry,
  annotations,
  stopDrain,
  pipelineBuffer,
  profile: profileReevaluation,
  fullCdp,
  screenRecording,
  storageArtifacts,
  liteNetworkBaseline,
  recordedTabWatch,
  tabsContextTracker,
  stoppedSessionLifecycle,
  tabs: chromeApi?.tabs,
  scripting: chromeApi?.scripting,
  action: chromeApi?.action,
  storageLocal: chromeApi?.storage?.local,
  broadcast: (message) => {
    portRegistry.broadcast(message);
  },
  notifyOffscreenPipelineStatus: () => {
    inboundRouter.notifyOffscreenPipelineStatus();
  },
  pushSessionList,
  scheduleSessionListPush: () => {
    sessionListPush.schedule();
  },
  ingestRawEvent,
  enqueueWithResult,
  updateSessionMetadataFromEvent: (runtime, event) => {
    inboundRouter.updateSessionMetadataFromEvent(runtime, event);
  },
  handleFreezeNotice: (runtime, reason) => {
    artifacts.handleFreezeNotice(runtime, reason);
  },
  getAtRestKey,
  ensureOffscreenDocument,
  createPipeline: (sid) => createSessionPipelineClient(offscreenClient, sid),
  loadPerformanceBudgetConfig,
  monotonicTime
});
const inboundRouter = createInboundRouter({
  sessionRegistry,
  portRegistry,
  stopDrain,
  offscreenClient,
  screenRecording,
  sessionCommands,
  sessionList: sessionListView,
  sessionExport,
  annotations,
  profile: profileReevaluation,
  contentInjection,
  storageArtifacts,
  tabsContextTracker,
  runtime: chromeApi?.runtime,
  tabs: chromeApi?.tabs,
  scripting: chromeApi?.scripting,
  offscreenPath: OFFSCREEN_PATH,
  resolveUiActionTarget,
  ingestRawEvent,
  sendAtRestKeyToOffscreen,
  recoverActiveOffscreenPipelines: recoverAllActiveOffscreenPipelines,
  markStoppedPipelinesDetached: () => {
    stoppedSessionLifecycle.markStoppedPipelinesDetached();
  },
  waitForRuntimeState: () => runtimeStateRestored,
  pushSessionList,
  wait,
  monotonicTime,
  perfNow,
  shouldLogPortDebug
});
let offscreenDocumentReady: Promise<void> | null = null;

const runtimeStateRestored = sessionCommands.restoreRuntimeState().catch((error) => {
  console.warn("[WebBlackbox] failed to restore runtime state", error);
});

// Retention of stopped, unexported recordings: alarms outlive the worker, timers do not.
chromeApi?.alarms?.onAlarm.addListener((alarm) => {
  const sid = sidFromRetentionAlarm(alarm.name);

  if (sid) {
    void stoppedSessionLifecycle.expireStoppedSession(sid).catch((error) => {
      console.warn("[WebBlackbox] failed to delete an expired recording", error);
    });
  }
});

// Wakes the worker at browser start, so the previous browser session's leftovers are deleted
// right away instead of on the first click.
chromeApi?.runtime?.onStartup?.addListener(() => {
  void getAtRestKey().catch(() => undefined);
});

// Every boot re-applies the setting: it also restores a registration an update dropped.
void contentInjection.sync();

chromeApi?.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === "local" && Object.hasOwn(changes, CONTENT_INJECTION_STORAGE_KEY)) {
    void contentInjection.sync();
  }
});

chromeApi?.runtime?.onInstalled.addListener(() => {
  void sessionCommands.setIdleBadge();
});

chromeApi?.runtime?.onConnect.addListener((port) => {
  inboundRouter.handlePortConnect(port);
});

chromeApi?.runtime?.onMessage.addListener((rawMessage, sender, sendResponse) => {
  return inboundRouter.handleRuntimeMessage(rawMessage, sender, sendResponse);
});

chromeApi?.commands?.onCommand.addListener((command) => {
  if (command !== "mark-bug") {
    return;
  }

  void inboundRouter.relayMarkerCommand();
});

// Deleting or editing a profile, or a policy change, re-checks running recordings at once.
chromeApi?.storage?.onChanged?.addListener((changes, areaName) => {
  if (!isProfileSettingsChange(changes, areaName)) {
    return;
  }

  for (const runtime of sessionRegistry.tabRuntimes()) {
    profileReevaluation.scheduleProfileReevaluation(runtime, "settings-changed");
  }
});

function createTabsContextTracker(): TabsContextTracker | null {
  const tabs = chromeApi?.tabs;

  if (!tabs?.onCreated || !tabs.onUpdated || !tabs.onRemoved || !tabs.onActivated) {
    return null;
  }

  return new TabsContextTracker(
    {
      tabs: {
        query: (queryInfo) => tabs.query(queryInfo),
        get: (tabId) => tabs.get(tabId),
        onCreated: tabs.onCreated,
        onUpdated: tabs.onUpdated,
        onRemoved: tabs.onRemoved,
        onActivated: tabs.onActivated
      },
      windows: chromeApi?.windows
    },
    {
      emit: ingestTabsContext,
      onError: (error) => {
        console.warn("[WebBlackbox] other tabs of the site could not be read", error);
      }
    }
  );
}

function ingestTabsContext(recordedTabId: number, emission: TabsContextEmission): void {
  const runtime = sessionRegistry.getByTab(recordedTabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  ingestRawEvent({
    source: "system",
    rawType: emission.rawType,
    sid: runtime.sid,
    tabId: recordedTabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: emission.payload
  });
}

/**
 * `arrivedBeforeStop`: the event reached the service worker while recording and only waited in
 * the ordered CDP chain, so a stop in the meantime must not drop it.
 */
function ingestRawEvent(
  rawEvent: RawRecorderEvent,
  options: { arrivedBeforeStop?: boolean } = {}
): void {
  const runtime = resolveRawEventSession(rawEvent, sessionRegistry.byTab, sessionRegistry.bySid);

  if (!runtime) {
    return;
  }

  if (
    runtime.stopping &&
    rawEvent.source !== "system" &&
    !options.arrivedBeforeStop &&
    !shouldAllowStopDrainContentEvent(runtime, rawEvent)
  ) {
    return;
  }

  if (rawEvent.source === "content" && rawEvent.rawType === SCRIPT_RAW_TYPE) {
    fullCdp.recordScriptSourceMap(runtime, readContentScriptRecord(rawEvent.payload));
    return;
  }

  const nextRawEvent: RawRecorderEvent = {
    ...rawEvent,
    sid: runtime.sid
  };

  updateRuntimeInteractionState(runtime, nextRawEvent);

  if (shouldMaterializeLiteContentEvent(runtime, nextRawEvent)) {
    enqueue(runtime, async () => {
      const materialized = await materializeLiteContentEvent(runtime, nextRawEvent);

      if (!materialized) {
        return;
      }

      runtime.recorder.ingest(materialized);
    });

    return;
  }

  if (
    runtime.mode === "full" &&
    screenshotArtifacts.shouldCaptureActionScreenshot(nextRawEvent, runtime)
  ) {
    runtime.lastActionScreenshotMono = nextRawEvent.mono;
    enqueue(
      runtime,
      async () => {
        await screenshotArtifacts.captureScreenshot(runtime, `action:${nextRawEvent.rawType}`);
      },
      { bestEffort: true }
    );
  }

  runtime.recorder.ingest(nextRawEvent);
}

function updateRuntimeInteractionState(runtime: SessionRuntime, rawEvent: RawRecorderEvent): void {
  if (rawEvent.source !== "content") {
    return;
  }

  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return;
  }

  if (rawEvent.rawType === "resize") {
    const width = asFiniteNumber(payload.width);
    const height = asFiniteNumber(payload.height);
    const dpr = asFiniteNumber(payload.dpr) ?? runtime.lastViewport?.dpr ?? 1;

    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      runtime.lastViewport = {
        width: Math.round(width),
        height: Math.round(height),
        dpr: Number(dpr.toFixed(2))
      };
    }

    return;
  }

  if (POINTER_TRACKING_RAW_TYPES.has(rawEvent.rawType)) {
    const x = asFiniteNumber(payload.x);
    const y = asFiniteNumber(payload.y);

    if (typeof x === "number" && typeof y === "number") {
      runtime.lastPointer = {
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        t: rawEvent.t,
        mono: rawEvent.mono
      };
    }
  }
}

const POINTER_TRACKING_RAW_TYPES = new Set([
  "mousemove",
  "click",
  "dblclick",
  "pointerdown",
  "pointerup",
  "contextmenu",
  "auxclick"
]);

async function ensureOffscreenPortReady(): Promise<PortLike> {
  await orphanedOffscreenCleanup;
  return offscreenPortConnector.ensurePort();
}

async function recoverAllActiveOffscreenPipelines(): Promise<void> {
  for (const runtime of sessionRegistry.tabRuntimes()) {
    if (runtime.stopping || runtime.stoppedAt) {
      continue;
    }

    await recoverOffscreenSession(runtime.sid);
  }
}

async function recoverOffscreenSession(sid: string): Promise<void> {
  const existing = offscreenSessionRecovery.get(sid);

  if (existing) {
    await existing;
    return;
  }

  const task = (async () => {
    const runtime = sessionRegistry.getBySid(sid);

    if (!runtime || runtime.stopping || runtime.stoppedAt) {
      return;
    }

    await offscreenClient.requestOnce({
      op: "start",
      sid,
      session: toSessionMetadata(runtime),
      redactionProfile: runtime.config.redaction,
      capturePolicy: runtime.config.capturePolicy
    });
    inboundRouter.notifyOffscreenPipelineStatus();
  })()
    .catch((error) => {
      console.warn("[WebBlackbox] failed to recover offscreen pipeline session", {
        sid,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    })
    .finally(() => {
      offscreenSessionRecovery.delete(sid);
    });

  offscreenSessionRecovery.set(sid, task);
  await task;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * This browser session's at-rest key. Each worker instance deletes the pipeline database before
 * any offscreen document opens it (see `bootstrapAtRestKey`). A failure is retried on the next
 * call.
 */
function getAtRestKey(): Promise<AtRestKeyRecord> {
  if (!atRestKeyReady) {
    atRestKeyReady = initializeAtRestKey().catch((error: unknown) => {
      atRestKeyReady = null;
      throw error;
    });
  }

  return atRestKeyReady;
}

async function initializeAtRestKey(): Promise<AtRestKeyRecord> {
  const state = await bootstrapAtRestKey(
    chromeApi?.storage?.session,
    globalThis.indexedDB,
    PIPELINE_DB_NAME,
    {
      onAccessLevelError: (error) => {
        console.warn("[WebBlackbox] failed to restrict storage.session access", error);
      }
    }
  );

  atRestKeyMinted = state.fresh;

  if (state.database === "unavailable") {
    console.warn("[WebBlackbox] IndexedDB is unavailable: leftover recordings were not cleared");
  } else if (state.fresh) {
    // "blocked": the deletion is queued and completes before the database is opened again.
    console.info("[WebBlackbox] new browser session: cleared unexported recordings", {
      outcome: state.database
    });
  }

  return state.record;
}

/** Hands the key to the offscreen document; the port was checked on connect. */
async function sendAtRestKeyToOffscreen(port: PortLike): Promise<void> {
  try {
    offscreenClient.post(port, toStorageKeyMessage(await getAtRestKey()));
  } catch (error) {
    console.warn("[WebBlackbox] failed to send the at-rest key to the offscreen document", error);
  }
}

/** Concurrent callers share one check-then-create: Chrome allows a single offscreen document. */
function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenDocumentReady) {
    offscreenDocumentReady = createOffscreenDocumentIfMissing().finally(() => {
      offscreenDocumentReady = null;
    });
  }

  return offscreenDocumentReady;
}

async function createOffscreenDocumentIfMissing(): Promise<void> {
  await orphanedOffscreenCleanup;

  if (await hasOffscreenDocument()) {
    return;
  }

  await createOffscreenDocument();
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (!chromeApi?.runtime?.getContexts || !chromeApi.runtime.getURL) {
    return false;
  }

  const contexts = await chromeApi.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chromeApi.runtime.getURL(OFFSCREEN_PATH)]
  });

  return contexts.length > 0;
}

/**
 * An offscreen document that outlives a service worker restart keeps pipelines and
 * capture streams the new worker does not track, and its port died with the old worker.
 * Stopped recordings were flushed to the encrypted store when they stopped and are
 * re-attached on demand, so close it and let the next request create a fresh one.
 */
async function closeOrphanedOffscreenDocument(): Promise<void> {
  if (sessionRegistry.sidCount() > 0 || !(await hasOffscreenDocument())) {
    return;
  }

  console.info("[WebBlackbox] closing offscreen document orphaned by a service worker restart");
  await chromeApi?.offscreen?.closeDocument();
}

async function createOffscreenDocument(): Promise<void> {
  if (!chromeApi?.offscreen?.createDocument) {
    return;
  }

  await chromeApi.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER", "USER_MEDIA"],
    justification:
      "WebBlackbox uses offscreen document for persistent local recording pipeline and optional tab video capture."
  });
}

function enqueue(
  runtime: SessionRuntime,
  task: () => Promise<void>,
  options: { bestEffort?: boolean } = {}
): boolean {
  if (options.bestEffort) {
    if (runtime.stopping || runtime.queueDepth >= BEST_EFFORT_QUEUE_MAX_PENDING) {
      runtime.droppedBestEffortTasks += 1;

      if (shouldLogPerf() && runtime.droppedBestEffortTasks % 50 === 0) {
        console.info("[WebBlackbox][perf] dropped best-effort queue tasks", {
          sid: runtime.sid,
          dropped: runtime.droppedBestEffortTasks,
          queueDepth: runtime.queueDepth
        });
      }

      return false;
    }
  }

  runtime.queueDepth += 1;
  runtime.queue = runtime.queue
    .then(task)
    .catch((error) => {
      console.warn("[WebBlackbox] session queue error", error);
    })
    .finally(() => {
      runtime.queueDepth = Math.max(0, runtime.queueDepth - 1);
    });

  return true;
}

function enqueueWithResult<TResult>(
  runtime: SessionRuntime,
  task: () => Promise<TResult>
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    enqueue(runtime, async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function loadPerformanceBudgetConfig(): Promise<PerformanceBudgetConfig> {
  await settingsMigrated;
  const storedValues = await chromeApi?.storage?.local?.get(PERFORMANCE_BUDGET_STORAGE_KEY);
  return normalizePerformanceBudget(storedValues?.[PERFORMANCE_BUDGET_STORAGE_KEY]);
}

function monotonicTime(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.timeOrigin + performance.now();
}

function perfNow(): number {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.now();
}

function shouldLogPerf(): boolean {
  return (
    (globalThis as unknown as Record<string, unknown>)[PERF_LOG_FLAG] === true ||
    (globalThis as unknown as Record<string, unknown>).__WEBBLACKBOX_PERF_LOGS__ === true
  );
}

function shouldLogPortDebug(): boolean {
  return (
    shouldLogPerf() ||
    (globalThis as unknown as Record<string, unknown>)[PORT_DEBUG_LOG_FLAG] === true
  );
}
