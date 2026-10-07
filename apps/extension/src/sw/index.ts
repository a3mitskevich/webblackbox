import { createCdpRouter, createChromeDebuggerTransport } from "@webblackbox/cdp-router";
import { IndexedDbPipelineStorage, sweepPipelineSessions } from "@webblackbox/pipeline/storage";
import { BODY_REDACTION_TOKEN } from "@webblackbox/protocol";

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
import { createAtRestKeyService } from "./at-rest-key-service.js";
import { createContentInjectionController } from "./content-injection.js";
import { createSessionExportController } from "./export-session.js";
import { createFullCdpController } from "./full-cdp.js";
import { createInboundRouter } from "./inbound-router.js";
import { createLiteNetworkBaselineController } from "./lite-network.js";
import { createNavigationRouter } from "./navigation-router.js";
import { createOffscreenClient, createSessionPipelineClient } from "./offscreen-client.js";
import { createOffscreenDocumentController } from "./offscreen-document.js";
import { createOffscreenPortConnector } from "./offscreen-port.js";
import { createOffscreenSessionRecovery } from "./offscreen-recovery.js";
import { shouldLogPerf, shouldLogPortDebug } from "./perf-flags.js";
import { createPipelineBuffer } from "./pipeline-buffer.js";
import { createPipelineIngest } from "./pipeline-ingest.js";
import { createPortRegistry } from "./port-registry.js";
import { createPortTrafficMeter } from "./port-traffic.js";
import { isProfileSettingsChange } from "./profile-change.js";
import { createProfileReevaluation } from "./profile-reevaluation.js";
import { createRecordedTabWatch } from "./recorded-tab-watch.js";
import { createSessionAnnotations } from "./session-annotations.js";
import { createSessionCommands } from "./session-commands.js";
import { createSessionListView, toSessionMetadata } from "./session-list.js";
import { createSessionQueue } from "./session-queue.js";
import { createSessionRegistry } from "./session-registry.js";
import { createStopDrainTracker } from "./stop-drain.js";
import { sidFromRetentionAlarm } from "./stopped-session-store.js";
import {
  createStoppedSessionLifecycle,
  type StoppedSessionLifecycleController
} from "./stopped-session-lifecycle.js";
import { createThrottledPush } from "./throttled-push.js";
import { monotonicTime, perfNow, wait } from "./time-utils.js";
import { TabsContextTracker, type TabsContextEmission } from "./tabs-context/tracker.js";
import { resolveUiActionTabId } from "./ui-action-target.js";

const chromeApi = getChromeApi();

const sessionRegistry = createSessionRegistry();

const OFFSCREEN_PATH = "offscreen.html";
const SERVICE_WORKER_BOOTED_AT = Date.now();
const BEST_EFFORT_QUEUE_MAX_PENDING = 80;
/** Shortest gap between session-list pushes driven by recorded events (counters, errors). */
const SESSION_LIST_EVENT_PUSH_INTERVAL_MS = 500;
// Full mode's "what the page captures" decision is made once, at the source: the capture agent
// applies `shouldPageCapture` (webblackbox/capture-scope); events that arrive here are trusted.
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
const { enqueue, enqueueWithResult } = createSessionQueue({
  bestEffortQueueMaxPending: BEST_EFFORT_QUEUE_MAX_PENDING,
  shouldLogPerf
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

const offscreenDocuments = createOffscreenDocumentController({
  offscreen: chromeApi?.offscreen,
  runtime: chromeApi?.runtime,
  offscreenPath: OFFSCREEN_PATH,
  sidCount: () => sessionRegistry.sidCount()
});
const { ingestRawEvent } = createPipelineIngest({
  byTab: sessionRegistry.byTab,
  bySid: sessionRegistry.bySid,
  enqueue,
  getFullCdp: () => fullCdp,
  getScreenshotArtifacts: () => screenshotArtifacts
});
const recordedTabWatch = createRecordedTabWatch(chromeApi, {
  onTabUpdated: (tabId, changeInfo) => {
    navigationRouter.handleRecordedTabUpdated(tabId, changeInfo);
  },
  onTabRemoved: (tabId) => {
    void sessionCommands.stopSession(tabId);
  },
  onFrameCommitted: (details) => {
    navigationRouter.handleRecordedFrameCommitted(details);
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
    hasDocument: offscreenDocuments.hasOffscreenDocument,
    createDocument: offscreenDocuments.createOffscreenDocument,
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
const offscreenRecovery = createOffscreenSessionRecovery({
  getRuntimeBySid: (sid) => sessionRegistry.getBySid(sid),
  tabRuntimes: () => sessionRegistry.tabRuntimes(),
  offscreenClient: {
    requestOnce: (request) => offscreenClient.requestOnce(request)
  },
  notifyOffscreenPipelineStatus: () => {
    inboundRouter.notifyOffscreenPipelineStatus();
  }
});
const offscreenClient = createOffscreenClient({
  ensurePort: ensureOffscreenPortReady,
  recoverSession: offscreenRecovery.recoverOffscreenSession,
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
const { getAtRestKey, isAtRestKeyFresh, sendAtRestKeyToOffscreen } = createAtRestKeyService({
  storageArea: chromeApi?.storage?.session,
  indexedDb: globalThis.indexedDB,
  dbName: PIPELINE_DB_NAME,
  post: (port, message) => offscreenClient.post(port, message)
});

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
  isAtRestKeyFresh,
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
    navigationRouter.updateSessionMetadataFromEvent(runtime, event);
  },
  handleFreezeNotice: (runtime, reason) => {
    artifacts.handleFreezeNotice(runtime, reason);
  },
  getAtRestKey,
  ensureOffscreenDocument: offscreenDocuments.ensureOffscreenDocument,
  createPipeline: (sid) => createSessionPipelineClient(offscreenClient, sid),
  loadPerformanceBudgetConfig,
  monotonicTime
});
const navigationRouter = createNavigationRouter({
  sessionRegistry,
  sessionCommands,
  profile: profileReevaluation,
  contentInjection,
  storageArtifacts,
  tabsContextTracker,
  runtime: chromeApi?.runtime,
  scripting: chromeApi?.scripting,
  pushSessionList
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
  runtime: chromeApi?.runtime,
  tabs: chromeApi?.tabs,
  scripting: chromeApi?.scripting,
  offscreenPath: OFFSCREEN_PATH,
  resolveUiActionTarget,
  ingestRawEvent,
  sendAtRestKeyToOffscreen,
  recoverActiveOffscreenPipelines: offscreenRecovery.recoverAllActiveOffscreenPipelines,
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

async function ensureOffscreenPortReady(): Promise<PortLike> {
  await offscreenDocuments.orphanedCleanup;
  return offscreenPortConnector.ensurePort();
}

async function loadPerformanceBudgetConfig(): Promise<PerformanceBudgetConfig> {
  await settingsMigrated;
  const storedValues = await chromeApi?.storage?.local?.get(PERFORMANCE_BUDGET_STORAGE_KEY);
  return normalizePerformanceBudget(storedValues?.[PERFORMANCE_BUDGET_STORAGE_KEY]);
}
