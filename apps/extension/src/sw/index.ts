import {
  createCdpRouter,
  createChromeDebuggerTransport,
  type CdpRouter
} from "@webblackbox/cdp-router";
import { IndexedDbPipelineStorage, sweepPipelineSessions } from "@webblackbox/pipeline/storage";
import {
  createSessionId,
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_EXPORT_POLICY,
  DEFAULT_POINTER_CAPTURE_OPTIONS,
  DEFAULT_RECORDER_CONFIG,
  assertExportPassphrase,
  isValidExportPassphrase,
  maskBodyBytes,
  maskBodyText,
  normalizeExportPassphrase,
  sanitizeUrlForPrivacy,
  type CapturePolicy,
  type CaptureMode,
  type ExportPolicy,
  type FreezeReason,
  type PointerCaptureOptions,
  type PrivacyScannerResult,
  type SessionMetadata,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import {
  BODY_SKIPPED_RAW_TYPE,
  createDefaultRecorderPlugins,
  type RawRecorderEvent,
  WebBlackboxRecorder
} from "@webblackbox/recorder";
import { INJECTED_BRIDGE_NONCE_SETTER_KEY } from "webblackbox/injected-hooks";
import { decodeScreenshotDataUrl } from "webblackbox/lite-materializer";

import { PIPELINE_DB_NAME } from "../shared/at-rest.js";
import {
  getChromeApi,
  type ChromeTabChangeInfo,
  type FrameCommittedDetails,
  type PortLike,
  type RuntimeMessageSender
} from "../shared/chrome-api.js";
import { CONTENT_INJECTION_STORAGE_KEY } from "../shared/content-injection.js";
import {
  PORT_NAMES,
  type ExportPrivacyWarning,
  type ExtensionInboundMessage,
  type ExtensionOutboundMessage,
  type FullModeVisualCapture,
  type SessionListMessage,
  type SessionListItem
} from "../shared/messages.js";
import {
  OFFSCREEN_CONNECT_REQUEST_KIND,
  type PipelineExportDownloadResult,
  type ScreenRecordingChunkMessage,
  type ScreenRecordingEndedMessage,
  type ScreenRecordingErrorMessage,
  type ScreenRecordingStopResult,
  type SwPipelineStatusMessage
} from "../shared/offscreen-messages.js";
import {
  normalizePerformanceBudget,
  PERFORMANCE_BUDGET_STORAGE_KEY,
  type PerformanceBudgetConfig
} from "../shared/performance-budget.js";
import {
  capStorageValue,
  capturesPageStorageInFullMode,
  isPageEventKeptInFullMode
} from "webblackbox/capture-scope";
import { materializeLiteRawEvent } from "webblackbox/lite-materializer";
import {
  AUTO_PROFILE_ID,
  buildProfileRecorderConfig,
  listEnterpriseCappedCategories,
  resolveSourceMapCapture,
  selectRecordingProfile,
  toArchivedProfileInfo,
  type ProfileSelection,
  type SourceMapCapture
} from "../shared/profiles/resolve.js";
import {
  DEBUGGER_SCRIPT_CACHE_BYTES,
  loadSourceMapForEmbedding,
  SCRIPT_RAW_TYPE,
  scriptRecordFromResponse,
  scriptRecordFromScriptParsed,
  type RawScriptRecord
} from "./source-maps.js";
import { resolveStartEngine } from "../shared/profiles/engine.js";
import type { ProfilesState } from "../shared/profiles/storage.js";
import {
  resolveLocalDataSettings,
  resolveUnexportedRetentionMs
} from "../shared/profiles/local-data.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  createBoundedManagedPolicyReader,
  ENTERPRISE_POLICY_STORAGE_KEY,
  getSessionStartBlockReason,
  isEnterpriseOriginAllowed,
  normalizeEnterprisePolicy,
  readManagedEnterprisePolicy,
  type EnterpriseRecorderPolicy
} from "../shared/options-storage.js";
import { migrateSettingsStorage } from "../shared/settings-migration.js";
import {
  applyBodyUrlFilters,
  isMimeAllowed as isMimeAllowedUtil,
  normalizeBodyCaptureMaxBytes as normalizeBodyCaptureMaxBytesUtil,
  normalizeMimeType as normalizeMimeTypeUtil,
  isInlineRequestBodyAllowed,
  resolveFullBodyCaptureRule as resolveFullBodyCaptureRuleUtil,
  resolveLiteBodyCaptureRule as resolveLiteBodyCaptureRuleUtil,
  transformResponseBodyForCapture
} from "./body-capture-utils.js";
import {
  shouldStopForCaptureScopeOriginChange,
  shouldStopForEnterpriseOriginPolicy as shouldStopForEnterpriseOriginPolicyInput
} from "./capture-scope.js";
import {
  bootstrapAtRestKey,
  isOffscreenDocumentPort,
  toStorageKeyMessage,
  type AtRestKeyRecord
} from "./at-rest-key.js";
import { primeChildSession } from "./child-session-prime.js";
import { withCdpCommandTimeout, type CdpCommandOutcome } from "./cdp-command.js";
import {
  createContentInjectionController,
  injectContentScriptIntoFrame,
  isInjectableFrameUrl
} from "./content-injection.js";
import {
  completeRequestPostData,
  FullBodyCapture,
  needsRequestPostData,
  type FinishedResponse,
  type ReadBody
} from "./full-body-capture.js";
import {
  clearRetentionAlarm,
  createStoppedSessionStore,
  MAX_STOPPED_SESSION_PURGE_ATTEMPTS,
  planStoppedSessionRestore,
  scheduleRetentionAlarm,
  sidFromRetentionAlarm,
  type StoppedSessionSnapshot
} from "./stopped-session-store.js";
import {
  buildLiteNetworkFailureRawEvent,
  buildLiteNetworkRequestRawEvent,
  buildLiteNetworkResponseRawEvent
} from "./lite-network-baseline.js";
import { shouldUpdateSessionMetadataFromNavigation } from "./navigation-metadata.js";
import {
  createOffscreenClient,
  createSessionPipelineClient,
  OFFSCREEN_DISCONNECTED_ERROR,
  type OffscreenEventMessage
} from "./offscreen-client.js";
import { createOffscreenPortConnector } from "./offscreen-port.js";
import { createPortTrafficMeter } from "./port-traffic.js";
import { createRecordedTabWatch } from "./recorded-tab-watch.js";
import { extractPerformanceBudgetNetworkSample } from "./performance-budget.js";
import {
  classifyMessageSender,
  classifyPortSender,
  isBroadcastDeliveredToPort,
  isInboundKindAllowed,
  type InboundSenderContext,
  type SenderTrustContext
} from "./port-sender.js";
import {
  buildProfileCancellation,
  detectProfileChange,
  isProfileSettingsChange,
  reselectStartedProfile,
  shouldDeferProfileCheck,
  toProfileCancelNotice,
  toSessionProfileRequest,
  type ProfileCancellation,
  type ProfileCancelTrigger,
  type SessionProfileSnapshot
} from "./profile-change.js";
import {
  buildProfilePreview,
  loadProfilesState,
  capturedVisualsOf,
  isTabLoading,
  NO_RECORDING_PROFILE_ERROR,
  readTabPageContext
} from "./profile-runtime.js";
import {
  buildRequestMetaKey,
  deleteRequestMeta,
  getRequestMeta,
  upsertRequestMeta
} from "./request-meta.js";
import {
  createSessionRegistry,
  createSessionRuntime,
  rememberablePageUrl,
  resolveUrlOrigin,
  type ScreenRecordingRuntime,
  type SessionAnnotation,
  type SessionRuntime
} from "./session-registry.js";
import { resolveRawEventSession } from "./session-routing.js";
import {
  parseStoppedSessionRecords,
  pruneStoppedSessionRecords,
  removeStoppedSessionRecord,
  resolveStoppedSessionTtlMs,
  shouldSweepStoredSession,
  STOPPED_SESSIONS_STORAGE_KEY,
  upsertStoppedSessionRecord,
  type StoppedSessionRecord
} from "./stopped-sessions.js";
import { startWithOptionalReload } from "./start-with-reload.js";
import { createThrottledPush } from "./throttled-push.js";
import {
  FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS,
  buildLocalStorageSnapshotExpression,
  parseStorageSnapshotMeta,
  type LocalStorageSnapshotMode
} from "./storage-snapshot.js";
import {
  resolveTabsContextLevel,
  TabsContextTracker,
  type TabsContextEmission
} from "./tabs-context/tracker.js";
import { resolveUiActionTabId } from "./ui-action-target.js";

type ExportAuditEvent = {
  schemaVersion: 1;
  timestamp: string;
  sid: string;
  mode: CaptureMode;
  outcome: "ok" | "error";
  encrypted: boolean;
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number;
  recentWindowMs: number;
  sizeBytes?: number;
  downloadId?: number;
  error?: string;
};

type RecordingSampling = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  snapshotIntervalMs: number;
  screenshotIdleMs: number;
  bodyCaptureMaxBytes: number;
};

type LiteBodyCaptureRule = {
  enabled: boolean;
  maxBytes: number;
  mimeAllowlist: string[];
};

const chromeApi = getChromeApi();

const sessionRegistry = createSessionRegistry();
const sessionAnnotations = new Map<string, SessionAnnotation>();
const connectedPorts = new Set<PortLike>();
let offscreenPort: PortLike | null = null;
const pendingStopDrainAcks = new Map<
  string,
  {
    sid: string;
    tabId: number;
    ackReceived: boolean;
    resolve: () => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
const inFlightContentMessagesByTab = new Map<number, number>();
const offscreenSessionRecovery = new Map<string, Promise<void>>();
let freezeBadgeTimer: ReturnType<typeof setTimeout> | null = null;
let stoppedSessionRecordsQueue: Promise<unknown> = Promise.resolve();
let liteWebRequestCaptureCleanup: (() => void) | null = null;

const OFFSCREEN_PATH = "offscreen.html";
const SERVICE_WORKER_BOOTED_AT = Date.now();
const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const POINTER_STALE_MS = 2_500;
const NETWORK_BODY_MAX_BYTES = 256 * 1024;
/**
 * How long stop waits for response bodies still being read before recording them as skipped:
 * a base plus a share per pending body, capped.
 */
const FULL_MODE_BODY_STOP_DRAIN_MS = 3_000;
const FULL_MODE_BODY_STOP_DRAIN_PER_BODY_MS = 25;
const FULL_MODE_BODY_STOP_DRAIN_MAX_MS = 15_000;
/** CDP events waiting behind request body reads before new reads are skipped as `backlog`. */
const FULL_MODE_CDP_INGEST_MAX_BACKLOG = 500;
/** How long a request body CDP left out of `requestWillBeSent` may take to read. */
const FULL_MODE_POST_DATA_TIMEOUT_MS = 2_000;
const FULL_MODE_INCIDENT_CAPTURE_COOLDOWN_MS = 15_000;
const FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS = 12_000;
const FREEZE_NOTICE_COOLDOWN_MS = 20_000;
const FREEZE_BADGE_HIGHLIGHT_MS = 15_000;
const PERFORMANCE_BUDGET_BREACH_COOLDOWN_MS = 15_000;
const PERFORMANCE_BUDGET_ERROR_RATE_MIN_SAMPLES = 10;
const BEST_EFFORT_QUEUE_MAX_PENDING = 80;
const PIPELINE_BATCH_MAX_EVENTS = 160;
const PIPELINE_BATCH_DRAIN_CHUNK_EVENTS = 160;
const PIPELINE_BATCH_FLUSH_MS = 120;
/** Shortest gap between session-list pushes driven by recorded events (counters, errors). */
const SESSION_LIST_EVENT_PUSH_INTERVAL_MS = 500;
const CONTENT_EVENT_SLICE_BUDGET_MS = 8;
// Pointer samples are kept: the page samples them at the profile rate and drops them under load.
const SKIPPED_FULL_MODE_CONTENT_RAW_TYPES = new Set([
  "scroll",
  "mutation",
  "snapshot",
  "screenshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot",
  "networkBody",
  "fetch",
  "xhr",
  "fetchError",
  "console",
  "pageError",
  "unhandledrejection",
  "resourceError",
  "sse",
  "notice",
  SCRIPT_RAW_TYPE
]);
// Network bookkeeping for bodies runs inline (see `trackFullModeNetworkEvent`), never through
// the best-effort queue, which drops tasks under load.
const FULL_MODE_FOLLOWUP_METHODS = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Network.loadingFailed",
  "Runtime.exceptionThrown",
  "Page.frameNavigated"
]);
// Child sessions (iframes, workers) must be primed or their traffic is never recorded.
const FULL_MODE_REQUIRED_FOLLOWUP_METHODS = new Set(["Target.attachedToTarget"]);
const LITE_DEFAULT_BODY_MIME_ALLOWLIST = [
  "text/*",
  "application/json",
  "application/*+json",
  "application/xml",
  "application/*+xml",
  "application/javascript",
  "application/x-www-form-urlencoded"
];
/** Full mode reads bodies through CDP whatever loaded them, so SVG images (text) are kept too. */
const FULL_DEFAULT_BODY_MIME_ALLOWLIST = [...LITE_DEFAULT_BODY_MIME_ALLOWLIST, "image/svg+xml"];
const LITE_BODY_REDACTED_TOKEN = "[REDACTED]";
const LITE_SCREENSHOT_MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;
const LITE_SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;
const LITE_DOM_SNAPSHOT_MAX_BYTES = 1_500 * 1024;
const CPU_PROFILE_SAMPLE_MS = 350;
const HEAP_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";
const SESSION_ANNOTATIONS_STORAGE_KEY = "webblackbox.runtime.sessionAnnotations";
const EXPORT_AUDIT_STORAGE_KEY = "webblackbox.audit.exports";
const EXPORT_AUDIT_MAX_EVENTS = 200;
const ACTION_SCREENSHOT_RAW_TYPES = new Set(["click", "dblclick", "submit", "marker"]);
const STOP_DRAIN_CONTENT_RAW_TYPES = new Set([
  "snapshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot",
  "screenshot"
]);
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const PORT_DEBUG_LOG_FLAG = "__WEBBLACKBOX_DEBUG_PORT__";
const OFFSCREEN_PORT_READY_TIMEOUT_MS = 5_000;
const OFFSCREEN_PORT_READY_WAIT_MS = 25;
const STOP_DRAIN_ACK_TIMEOUT_MS = 3_000;
const CDP_ARTIFACT_TIMEOUT_MS = 5_000;
// Priming a live child session takes milliseconds; see primeChildSession.
const CHILD_SESSION_PRIME_TIMEOUT_MS = 5_000;
// Chrome can hold `storage.managed` reads back while the browser starts; see the reader.
const ENTERPRISE_POLICY_READ_TIMEOUT_MS = 3_000;
const CDP_HEAP_SNAPSHOT_TIMEOUT_MS = 8_000;
const SCREEN_RECORDING_OFFSCREEN_SOURCE = "tab";

const tabsContextTracker = createTabsContextTracker();

console.info("[WebBlackbox] service worker booted");

const contentInjection = createContentInjectionController(chromeApi);
const sessionListPush = createThrottledPush(
  () => broadcast(buildSessionListMessage()),
  SESSION_LIST_EVENT_PUSH_INTERVAL_MS
);
const recordedTabWatch = createRecordedTabWatch(chromeApi, {
  onTabUpdated: handleRecordedTabUpdated,
  onTabRemoved: (tabId) => {
    void stopSession(tabId);
  },
  onFrameCommitted: handleRecordedFrameCommitted
});
const offscreenPortConnector = createOffscreenPortConnector<PortLike>(
  {
    getPort: () => offscreenPort,
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
const offscreenPortTraffic = createPortTrafficMeter();
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
const stoppedSessionStore = createStoppedSessionStore(chromeApi?.storage?.session);
/** Stopped sessions whose pipeline the current offscreen document does not hold (yet). */
const detachedPipelineSids = new Set<string>();
const pipelineAttachments = new Map<string, Promise<void>>();
/** Bumped when the offscreen document goes away: attachments started before it are void. */
let offscreenGeneration = 0;
const disposingSids = new Set<string>();
let offscreenDocumentReady: Promise<void> | null = null;
/** A failed purge of a stopped recording is retried this much later. */
const STOPPED_SESSION_PURGE_RETRY_MS = 5 * 60_000;

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
const runtimeStateRestored = restoreRuntimeState().catch((error) => {
  console.warn("[WebBlackbox] failed to restore runtime state", error);
});

// Retention of stopped, unexported recordings: alarms outlive the worker, timers do not.
chromeApi?.alarms?.onAlarm.addListener((alarm) => {
  const sid = sidFromRetentionAlarm(alarm.name);

  if (sid) {
    void expireStoppedSession(sid).catch((error) => {
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
  void setIdleBadge();
});

chromeApi?.runtime?.onConnect.addListener((port) => {
  if (
    !Object.values(PORT_NAMES).includes(port.name as (typeof PORT_NAMES)[keyof typeof PORT_NAMES])
  ) {
    return;
  }

  const senderContext = resolvePortSenderContext(port);

  if (senderContext === "untrusted") {
    // Port names are chosen by the connecting script: never let an arbitrary frame
    // claim the offscreen pipeline or receive session broadcasts.
    console.warn("[WebBlackbox] rejected port from untrusted sender", {
      portName: port.name,
      tabId: port.sender?.tab?.id,
      frameId: port.sender?.frameId
    });
    port.disconnect?.();
    return;
  }

  // The offscreen port carries the at-rest key and every recorded event: only the extension's own
  // offscreen document may take it. The sender check above already covers this; the explicit
  // check keeps the key from depending on that classification alone.
  if (port.name === PORT_NAMES.offscreen && !isTrustedOffscreenPort(port)) {
    console.warn("[WebBlackbox] refused an offscreen port from another context", {
      tabId: port.sender?.tab?.id
    });
    port.disconnect?.();
    return;
  }

  connectedPorts.add(port);

  if (port.name === PORT_NAMES.offscreen) {
    offscreenPort = port;
    void sendAtRestKeyToOffscreen(port);
    notifyOffscreenPipelineStatus();
  }

  if (port.name === PORT_NAMES.content) {
    void syncContentPortStateOnConnect(port).catch((error) => {
      logInboundMessageFailure("content.connect", error, port);
    });
  }

  pushSessionList();

  const onMessage = (rawMessage: unknown) => {
    if (handleOffscreenRuntimeMessage(rawMessage, port)) {
      return;
    }

    const message = parseInboundMessage(rawMessage);

    if (!message || !isInboundKindAllowed(message.kind, senderContext)) {
      return;
    }

    dispatchInboundMessage(message, port);
  };

  const onDisconnect = () => {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
      offscreenClient.rejectPending(OFFSCREEN_DISCONNECTED_ERROR);
      markStoppedPipelinesDetached();

      if (sessionRegistry.tabCount() > 0) {
        void recoverAllActiveOffscreenPipelines().catch((error) => {
          console.warn("[WebBlackbox] failed to recover active offscreen pipelines", error);
        });
      }
    }

    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
});

function resolvePortSenderContext(port: PortLike): InboundSenderContext {
  const trustContext = resolveSenderTrustContext();
  return trustContext ? classifyPortSender(port.name, port.sender, trustContext) : "untrusted";
}

function resolveMessageSenderContext(sender: RuntimeMessageSender): InboundSenderContext {
  const trustContext = resolveSenderTrustContext();
  return trustContext ? classifyMessageSender(sender, trustContext) : "untrusted";
}

function resolveSenderTrustContext(): SenderTrustContext | null {
  const runtime = chromeApi?.runtime;

  if (!runtime?.id || typeof runtime.getURL !== "function") {
    return null;
  }

  return {
    extensionId: runtime.id,
    extensionOrigin: runtime.getURL("").replace(/\/+$/, ""),
    offscreenUrl: runtime.getURL(OFFSCREEN_PATH)
  };
}

async function syncContentPortStateOnConnect(port: PortLike): Promise<void> {
  const tabId = port.sender?.tab?.id;

  if (typeof tabId !== "number") {
    return;
  }

  const runtime = sessionRegistry.getByTab(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  // Only the connecting frame: re-running the hooks script resets a frame's live capture config
  // (the script installs inactive), and only that frame gets the recording status back below.
  await ensureInjectedHooks(tabId, runtime.injectedBridgeNonce, port.sender?.frameId);

  syncContentPortRecordingState(port);
}

function syncContentPortRecordingState(port: PortLike): void {
  const tabId = port.sender?.tab?.id;

  if (typeof tabId !== "number") {
    return;
  }

  const runtime = sessionRegistry.getByTab(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  const sampling = toStatusSampling(runtime);

  try {
    port.postMessage({
      kind: "sw.recording-status",
      active: true,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling,
      capturePolicy: runtime.config.capturePolicy,
      injectedBridgeNonce: runtime.injectedBridgeNonce,
      pointer: toStatusPointer(runtime),
      ...toScriptScanStatus(runtime)
    });
  } catch (error) {
    logPortSendFailure("sw.recording-status", error, {
      tabId,
      sid: runtime.sid,
      mode: runtime.mode
    });
  }
}

chromeApi?.runtime?.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = parseInboundMessage(rawMessage);

  if (!message || !isInboundKindAllowed(message.kind, resolveMessageSenderContext(sender))) {
    return;
  }

  void handleInboundMessage(message, undefined, sender.tab?.id, sender.frameId)
    .then((result) => {
      sendResponse(result ?? { ok: true });
    })
    .catch((error) => {
      logInboundMessageFailure(message.kind, error, undefined, {
        tabId: sender.tab?.id,
        frameId: sender.frameId
      });
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

function dispatchInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  senderTabId?: number,
  senderFrameId?: number
): void {
  void handleInboundMessage(message, port, senderTabId, senderFrameId).catch((error) => {
    logInboundMessageFailure(message.kind, error, port, {
      tabId: senderTabId,
      frameId: senderFrameId
    });
  });
}

chromeApi?.commands?.onCommand.addListener((command) => {
  if (command !== "mark-bug") {
    return;
  }

  void relayMarkerCommand();
});

function handleRecordedTabUpdated(tabId: number, changeInfo: ChromeTabChangeInfo): void {
  if (typeof changeInfo.url === "string" && changeInfo.url.length > 0) {
    void handleTabUrlChanged(tabId, changeInfo.url);
  }

  if (changeInfo.status === "complete") {
    void restoreTabInstrumentationAfterNavigation(tabId);
  }
}

/**
 * With injection on Start only, nothing registered covers a recorded tab's new documents, so each
 * committed frame (reload, navigation, iframe added later) gets the content script right away.
 */
function handleRecordedFrameCommitted(details: FrameCommittedDetails): void {
  const runtime = sessionRegistry.getByTab(details.tabId);

  if (
    !runtime ||
    runtime.stopping ||
    runtime.stoppedAt ||
    contentInjection.currentMode() !== "on-start" ||
    !isInjectableFrameUrl(details.url)
  ) {
    return;
  }

  void injectContentScriptIntoFrame(chromeApi, details.tabId, details.frameId);
}

// Deleting or editing a profile, or a policy change, re-checks running recordings at once.
chromeApi?.storage?.onChanged?.addListener((changes, areaName) => {
  if (!isProfileSettingsChange(changes, areaName)) {
    return;
  }

  for (const runtime of sessionRegistry.tabRuntimes()) {
    scheduleProfileReevaluation(runtime, "settings-changed");
  }
});

async function handleInboundMessage(
  message: ExtensionInboundMessage,
  port?: PortLike,
  senderTabId?: number,
  senderFrameId?: number
): Promise<unknown> {
  // A message may be what woke this worker: answer it once an earlier worker's stopped recordings
  // are restored, so they are listed and exportable.
  await runtimeStateRestored;

  if (message.kind === "ui.start") {
    const tabId = await resolveUiActionTarget(message.tabId, senderTabId);

    if (typeof tabId !== "number") {
      return;
    }

    // Both engines: the reload follows the start, so the capture (Full: CDP) sees the page load.
    await startWithOptionalReload(tabId, message.reloadPage === true, {
      start: () =>
        startSession(tabId, message.mode, {
          visualCapture: resolveFullModeVisualCapture(message),
          profileId: typeof message.profileId === "string" ? message.profileId : undefined
        }),
      reload: reloadRecordingTab,
      stop: stopSession
    });
    return;
  }

  if (message.kind === "ui.stop") {
    const tabId = await resolveUiActionTarget(message.tabId, senderTabId);

    if (typeof tabId !== "number") {
      return;
    }

    await stopSession(tabId);
    return;
  }

  if (message.kind === "ui.export") {
    return exportSession(
      message.sid,
      message.passphrase,
      message.saveAs,
      resolveExportPolicy(message.policy)
    );
  }

  if (message.kind === "ui.resolve-profile") {
    const preview = await resolveProfilePreview(message.tabId, senderTabId, message.profileId);

    if (port) {
      sendPortMessage(port, preview);
      return;
    }

    return preview;
  }

  if (message.kind === "ui.delete") {
    await deleteSessionBySid(message.sid);
    return;
  }

  if (message.kind === "ui.annotate") {
    await updateSessionAnnotation(message.sid, message.tags, message.note);
    return;
  }

  if (message.kind === "ui.ack-profile-cancel") {
    await acknowledgeProfileCancel(message.sid);
    return;
  }

  if (message.kind === "ui.request-session-list") {
    const sessionList = buildSessionListMessage();

    if (port) {
      sendPortMessage(port, sessionList);
      return;
    }

    return sessionList;
  }

  if (message.kind === "content.marker") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;
    const frame = normalizeContentFrameId(senderFrameId ?? port?.sender?.frameId);

    if (typeof tabId === "number") {
      ingestRawEvent({
        source: "content",
        rawType: "marker",
        tabId,
        sid: sessionRegistry.getByTab(tabId)?.sid ?? "",
        t: Date.now(),
        mono: monotonicTime(),
        frame,
        payload: {
          message: message.message
        }
      });
    }

    return;
  }

  if (message.kind === "content.ready") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;

    if (typeof tabId !== "number") {
      return {
        kind: "sw.recording-status",
        active: false
      };
    }

    const runtime = sessionRegistry.getByTab(tabId);

    if (!runtime || runtime.stoppedAt) {
      return {
        kind: "sw.recording-status",
        active: false
      };
    }

    // The sender's frame only: the reply below reaches only that frame's content script.
    await ensureInjectedHooks(
      tabId,
      runtime.injectedBridgeNonce,
      senderFrameId ?? port?.sender?.frameId
    );

    const sampling = toStatusSampling(runtime);

    if (port?.name === PORT_NAMES.content) {
      syncContentPortRecordingState(port);
      return {
        ok: true
      };
    }

    return {
      kind: "sw.recording-status",
      active: true,
      sid: runtime.sid,
      mode: runtime.mode,
      sampling,
      capturePolicy: runtime.config.capturePolicy,
      injectedBridgeNonce: runtime.injectedBridgeNonce,
      pointer: toStatusPointer(runtime),
      ...toScriptScanStatus(runtime)
    };
  }

  if (message.kind === "content.stop-drained") {
    markStopDrainAckReceived(message.sid);
    return;
  }

  if (message.kind === "content.events") {
    const tabId = senderTabId ?? port?.sender?.tab?.id;
    const frame = normalizeContentFrameId(senderFrameId ?? port?.sender?.frameId);

    if (
      typeof tabId !== "number" ||
      !Array.isArray(message.events) ||
      message.events.length === 0
    ) {
      return;
    }

    adjustInFlightContentMessages(tabId, 1);
    let sliceStartedAt = perfNow();

    try {
      for (const rawEvent of message.events) {
        ingestRawEvent({
          ...rawEvent,
          tabId,
          frame: rawEvent.frame ?? frame
        });

        if (perfNow() - sliceStartedAt >= CONTENT_EVENT_SLICE_BUDGET_MS) {
          await wait(0);
          sliceStartedAt = perfNow();
        }
      }
    } finally {
      adjustInFlightContentMessages(tabId, -1);
    }
  }
}

async function deleteSessionBySid(sid: string): Promise<void> {
  const runtime = sessionRegistry.getBySid(sid);

  if (!runtime) {
    if (sessionAnnotations.delete(sid)) {
      await persistSessionAnnotations().catch(() => undefined);
    }
    return;
  }

  if (!runtime.stoppedAt) {
    await stopSession(runtime.tabId);
  }

  await disposeStoppedSession(runtime);

  if (sessionAnnotations.delete(sid)) {
    await persistSessionAnnotations().catch(() => undefined);
    pushSessionList();
  }
}

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

/** Starts recording the tab; resolves with the engine it runs in. */
async function startSession(
  tabId: number,
  requestedMode: CaptureMode,
  options: { visualCapture?: FullModeVisualCapture; profileId?: string } = {}
): Promise<CaptureMode> {
  const existing = sessionRegistry.getByTab(tabId);

  if (existing) {
    await stopSession(tabId);
  }

  // Nothing is recorded unless it can be encrypted at rest.
  await getAtRestKey();
  await ensureOffscreenDocument();

  const sid = createSessionId();
  const startedAt = Date.now();
  const tabMetadata = await resolveTabSessionMetadata(tabId);
  const sessionOrigin = resolveUrlOrigin(sanitizeUrlForPrivacy(tabMetadata.url)) ?? "";
  const enterprisePolicy = await loadEnterprisePolicy();

  const startBlockReason = getSessionStartBlockReason(sessionOrigin, enterprisePolicy);

  if (startBlockReason) {
    throw new Error(startBlockReason);
  }

  const profileRequest = options.profileId ?? AUTO_PROFILE_ID;
  const profileSelection = await resolveTabProfileSelection(tabId, profileRequest);

  if (!profileSelection) {
    throw new Error(NO_RECORDING_PROFILE_ERROR);
  }

  // A profile that needs the Full engine never runs in Lite, whatever the caller asked for: Lite
  // would drop its bodies, socket messages and visuals without a trace. Upgrading (rather than
  // refusing) keeps the start the user asked for; the popup already shows the engine as Full.
  const mode = resolveStartEngine(requestedMode, profileSelection.profile);
  const loadedRecorderConfig = buildProfileRecorderConfig({
    mode,
    profile: profileSelection.profile,
    visualCapture: options.visualCapture
  });
  const recorderConfig = applyEnterprisePolicyToRecorderConfig(
    withSessionCapturePolicy(loadedRecorderConfig, {
      tabId,
      origin: sessionOrigin,
      startedAt
    }),
    enterprisePolicy
  );
  const performanceBudget = await loadPerformanceBudgetConfig();
  const annotation = getSessionAnnotation(sid);
  const metadata: SessionMetadata = {
    sid,
    tabId,
    startedAt,
    mode,
    url: sanitizeUrlForPrivacy(tabMetadata.url),
    title: tabMetadata.title,
    tags: [...annotation.tags]
  };

  const recorderPlugins = createDefaultRecorderPlugins();
  const pipeline = createSessionPipelineClient(offscreenClient, sid);
  await pipeline.start(metadata, recorderConfig.redaction, recorderConfig.capturePolicy);

  const runtime = createSessionRuntime(
    {
      sid,
      tabId,
      mode,
      profile: {
        request: toSessionProfileRequest(profileRequest, profileSelection),
        visualCapture: options.visualCapture,
        selection: profileSelection,
        profileConfig: loadedRecorderConfig,
        visualsCaptured: capturedVisualsOf(recorderConfig)
      },
      url: metadata.url,
      title: metadata.title,
      annotation,
      config: recorderConfig,
      startedAt,
      pipeline,
      recorderPlugins,
      performanceBudget,
      pageUrl: tabMetadata.url
    },
    { createFullBodyCapture }
  );

  runtime.recorder = new WebBlackboxRecorder(
    {
      ...recorderConfig,
      mode
    },
    {
      onEvent: (event) => {
        updateSessionMetadataFromEvent(runtime, event);
        trackSessionCounters(runtime, event);
        evaluatePerformanceBudget(runtime, event);
        enqueuePipelineEvent(runtime, event);
      },
      onFreeze: (reason) => {
        handleFreezeNotice(runtime, reason);
      },
      shouldKeepInlineNetworkBody: (context) =>
        isInlineRequestBodyAllowed(context, (url, mimeType) =>
          runtime.mode === "full"
            ? resolveFullBodyCaptureRule(runtime, url, mimeType)
            : resolveLiteBodyCaptureRule(runtime, url, mimeType)
        )
    },
    undefined,
    recorderPlugins
  );

  sessionRegistry.register(runtime);
  recordedTabWatch.sync(true);

  if (mode === "lite") {
    installLiteWebRequestCapture();
  }

  ingestRawEvent({
    source: "system",
    rawType: "config",
    sid,
    tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      ...recorderConfig,
      profile: toArchivedProfileInfo(
        profileSelection,
        listEnterpriseCappedCategories(loadedRecorderConfig, recorderConfig)
      )
    }
  });

  // Other tabs of the site right after the config, before instrumentation can take a while.
  await tabsContextTracker?.startSession(tabId, {
    url: tabMetadata.url,
    level: resolveTabsContextLevel(recorderConfig.capturePolicy)
  });

  await ensureContentScriptInjected(tabId);
  await ensureInjectedHooks(tabId, runtime.injectedBridgeNonce);

  if (mode === "full" && recorderConfig.capturePolicy?.categories.cdp !== "off") {
    await attachCdp(runtime);
  }

  if (shouldStartScreenRecording(runtime)) {
    try {
      await startScreenRecording(runtime);
    } catch (error) {
      await stopSession(tabId);
      throw error;
    }
  }

  const sampling = toStatusSampling(runtime);

  await setRecordingBadge();
  const pointer = toStatusPointer(runtime);

  await notifyTabStatus(
    tabId,
    true,
    sid,
    mode,
    sampling,
    recorderConfig.capturePolicy,
    runtime.injectedBridgeNonce,
    pointer
  );
  broadcast({
    kind: "sw.recording-status",
    active: true,
    sid,
    mode,
    sampling,
    capturePolicy: recorderConfig.capturePolicy,
    pointer,
    ...toScriptScanStatus(runtime)
  });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
  return mode;
}

async function reloadRecordingTab(tabId: number): Promise<void> {
  if (!chromeApi?.tabs?.reload) {
    throw new Error("Current Chrome API cannot reload the active tab.");
  }

  await chromeApi.tabs.reload(tabId);
}

async function restoreTabInstrumentationAfterNavigation(tabId: number): Promise<void> {
  const runtime = sessionRegistry.getByTab(tabId);

  if (!runtime || runtime.stopping || runtime.stoppedAt) {
    return;
  }

  await ensureContentScriptInjected(tabId);
  await ensureInjectedHooks(tabId, runtime.injectedBridgeNonce);
  await notifyTabStatus(
    tabId,
    true,
    runtime.sid,
    runtime.mode,
    toStatusSampling(runtime),
    runtime.config.capturePolicy,
    runtime.injectedBridgeNonce,
    toStatusPointer(runtime)
  );
  // Title, meta tags and selectors are only reliable once the page has loaded.
  scheduleProfileReevaluation(runtime, "page-loaded");
}

async function stopSession(tabId: number): Promise<void> {
  const runtime = sessionRegistry.getByTab(tabId);

  if (!runtime || runtime.stopping) {
    return;
  }

  runtime.stopping = true;
  // Changes of other tabs seen before Stop still belong to the session.
  await tabsContextTracker?.settle();
  tabsContextTracker?.stopSession(tabId);
  const stopDrainAck = createStopDrainAck(runtime);
  await stopScreenRecording(runtime, "session-stop").catch((error) => {
    console.warn("[WebBlackbox] failed to stop screen recording", error);
  });

  if (runtime.mode === "full" && runtime.config.capturePolicy?.categories.cookies === "allow") {
    await captureCookieValues(runtime, "session-stop").catch((error) => {
      console.warn("[WebBlackbox] failed to capture cookie values at stop", error);
    });
  }

  // Bodies still being read are kept (or recorded as skipped) before the debugger detaches.
  await runtime.fullBodyCapture.drain(
    Math.min(
      FULL_MODE_BODY_STOP_DRAIN_MAX_MS,
      FULL_MODE_BODY_STOP_DRAIN_MS +
        runtime.fullBodyCapture.pendingCount() * FULL_MODE_BODY_STOP_DRAIN_PER_BODY_MS
    )
  );
  await runtime.cdpIngestChain;
  await flushBufferedPipelineEvents(runtime);
  await teardownCaptureInstrumentation(runtime);
  sessionRegistry.unregisterTab(runtime.tabId);
  recordedTabWatch.sync(sessionRegistry.tabCount() > 0);
  uninstallLiteWebRequestCaptureIfUnused();
  runtime.stoppedAt = Date.now();
  scheduleStoppedRuntimeCleanup(runtime);
  await rememberStoppedSessionRecord(runtime).catch((error) => {
    console.warn("[WebBlackbox] failed to persist stopped session record", error);
  });
  // Written now and again after the final flush: the worker may die while the page drains.
  await rememberStoppedSession(runtime);

  await refreshActionBadge();

  await notifyTabStatus(
    tabId,
    false,
    runtime.sid,
    runtime.mode,
    toStatusSampling(runtime),
    runtime.config.capturePolicy
  );
  broadcast({
    kind: "sw.recording-status",
    active: false,
    sid: runtime.sid,
    mode: runtime.mode,
    capturePolicy: runtime.config.capturePolicy
  });
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
  await stopDrainAck;
  await flushBufferedPipelineEvents(runtime);
  runtime.stopDrained = true;
  // The recording now waits for its export, possibly in a later worker: its tail goes to the
  // encrypted store and a snapshot lets that worker list and export it.
  await enqueueWithResult(runtime, () => runtime.pipeline.flush()).catch((error) => {
    console.warn("[WebBlackbox] failed to flush the stopped recording", error);
  });
  await rememberStoppedSession(runtime);
}

async function exportSession(
  sid: string,
  passphrase: string | undefined,
  saveAs = true,
  policy: ExportPolicy = DEFAULT_EXPORT_POLICY
): Promise<
  | { ok: true; fileName: string; privacyWarning?: ExportPrivacyWarning }
  | { ok: false; error: string }
> {
  const runtime = sessionRegistry.getBySid(sid);

  if (!runtime) {
    const error = "Session not found for export.";
    console.warn("[WebBlackbox] export ignored; unknown session", sid);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error
    });
    return {
      ok: false,
      error
    };
  }

  const effectivePolicy = resolveSessionExportPolicy(runtime, policy);
  // Every archive is encrypted, whatever the profile; whitespace around it is not part of it.
  const encryptionPassphrase = normalizeExportPassphrase(passphrase);

  try {
    // Before stopping the session: a refused export leaves the recording running.
    assertExportPassphrase(encryptionPassphrase);

    if (!runtime.stoppedAt) {
      await stopSession(runtime.tabId);
    }

    await flushBufferedPipelineEvents(runtime);
    await attachStoppedPipeline(runtime);

    const exported = await enqueueWithResult(runtime, async () => {
      return runtime.pipeline.exportAndDownload({
        passphrase: encryptionPassphrase,
        includeScreenshots: effectivePolicy.includeScreenshots,
        includeScreenRecordings: effectivePolicy.includeScreenRecordings,
        maxArchiveBytes: effectivePolicy.maxArchiveBytes,
        recentWindowMs: effectivePolicy.recentWindowMs
      });
    });

    await downloadExportedBundle(exported, saveAs);
    const privacyWarning = buildExportPrivacyWarning(exported.privacyScanner);
    await appendExportAuditEvent({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      sid,
      mode: runtime.mode,
      outcome: "ok",
      encrypted: true,
      includeScreenshots: effectivePolicy.includeScreenshots,
      includeScreenRecordings: effectivePolicy.includeScreenRecordings,
      maxArchiveBytes: effectivePolicy.maxArchiveBytes,
      recentWindowMs: effectivePolicy.recentWindowMs,
      sizeBytes: exported.sizeBytes,
      downloadId: exported.downloadId
    });
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: true,
      fileName: exported.fileName,
      privacyWarning
    });

    // The profile decides whether the local copy goes now or waits out its retention.
    if (
      runtime.stoppedAt &&
      resolveLocalDataSettings(runtime.profile.selection.profile).deleteAfterExport
    ) {
      await disposeStoppedSession(runtime);
    }

    return {
      ok: true,
      fileName: exported.fileName,
      privacyWarning
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendExportAuditEvent({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      sid,
      mode: runtime.mode,
      outcome: "error",
      encrypted: isValidExportPassphrase(encryptionPassphrase),
      includeScreenshots: effectivePolicy.includeScreenshots,
      includeScreenRecordings: effectivePolicy.includeScreenRecordings,
      maxArchiveBytes: effectivePolicy.maxArchiveBytes,
      recentWindowMs: effectivePolicy.recentWindowMs,
      error: redactOperationalMessage(message)
    });
    console.warn("[WebBlackbox] export failed", error);
    broadcast({
      kind: "sw.export-status",
      sid,
      ok: false,
      error: message
    });
    return {
      ok: false,
      error: message
    };
  }
}

/**
 * Resolves the profile for a tab from the current store, rules and page signals; null when no
 * profile exists.
 */
async function resolveTabProfileSelection(
  tabId: number,
  request: string
): Promise<ProfileSelection | null> {
  const state = await loadSessionProfilesState();
  const page = (await readTabPageContext(chromeApi, tabId, state.rules)) ?? {
    url: `tab:${tabId}`
  };

  return selectRecordingProfile({ state, page, requestedProfileId: request });
}

async function loadSessionProfilesState(): Promise<ProfilesState> {
  await settingsMigrated;
  return loadProfilesState(
    chromeApi,
    { enterprisePolicyKey: ENTERPRISE_POLICY_STORAGE_KEY },
    readEnterprisePolicy
  );
}

async function resolveProfilePreview(
  requestedTabId: number | undefined,
  senderTabId: number | undefined,
  requestedProfileId: string | undefined
): Promise<ReturnType<typeof buildProfilePreview>> {
  const state = await loadSessionProfilesState();
  // The same tab `ui.start` would record, so the preview shows the profile Start applies.
  const tabId = await resolveUiActionTarget(requestedTabId, senderTabId);

  if (typeof tabId !== "number") {
    return buildProfilePreview(state, null);
  }

  const page = await readTabPageContext(chromeApi, tabId, state.rules);
  const selection = page
    ? selectRecordingProfile({
        state,
        page,
        requestedProfileId: requestedProfileId ?? AUTO_PROFILE_ID
      })
    : null;

  if (!selection) {
    return buildProfilePreview(state, null);
  }

  // The preview renders the profile on its recommended transport to name the enterprise caps.
  const profileConfig = buildProfileRecorderConfig({
    mode: selection.profile.base,
    profile: selection.profile
  });
  const effectiveConfig = applyEnterprisePolicyToRecorderConfig(
    profileConfig,
    await loadEnterprisePolicy()
  );

  return buildProfilePreview(
    state,
    selection,
    listEnterpriseCappedCategories(profileConfig, effectiveConfig)
  );
}

/**
 * Serializes profile re-evaluations per session. Only the latest request runs: older queued or
 * in-flight ones are dropped, so a navigation burst costs one page probe, not one per step.
 */
function scheduleProfileReevaluation(runtime: SessionRuntime, trigger: ProfileCancelTrigger): void {
  const generation = nextProfileGeneration(runtime);

  runtime.profile.reevaluation = runtime.profile.reevaluation
    .then(() => reevaluateSessionProfile(runtime, trigger, generation))
    .catch((error) => {
      console.warn("[WebBlackbox] recording profile re-evaluation failed", error);
    });
}

function nextProfileGeneration(runtime: SessionRuntime): number {
  const generation = runtime.profile.generation + 1;
  runtime.profile = { ...runtime.profile, generation };
  return generation;
}

function isProfileRequestCurrent(runtime: SessionRuntime, generation: number): boolean {
  return runtime.profile.generation === generation && !runtime.stopping && !runtime.stoppedAt;
}

/**
 * Re-runs the rules after navigation or page load. A session records with one profile: when the
 * effective profile is no longer the one it started with (another profile picked by the rules,
 * the profile deleted or edited, the enterprise policy changed), the recording is cancelled.
 * What was captured is kept for export or deletion, and the popup explains why and how to fix it.
 */
async function reevaluateSessionProfile(
  runtime: SessionRuntime,
  trigger: ProfileCancelTrigger,
  generation: number
): Promise<void> {
  if (!isProfileRequestCurrent(runtime, generation)) {
    return;
  }

  const [state, enterprisePolicy, tabLoading] = await Promise.all([
    loadSessionProfilesState(),
    loadEnterprisePolicy(),
    isTabLoading(chromeApi, runtime.tabId)
  ]);

  // Rules that read the page cannot match before it loads; the page-loaded check decides.
  if (shouldDeferProfileCheck({ trigger, tabLoading, rules: state.rules })) {
    return;
  }

  const page = await readTabPageContext(chromeApi, runtime.tabId, state.rules, {
    requireSignals: true
  });

  const started = runtime.profile.selection;
  // A tab or page that cannot be read right now says nothing about the rules: only the started
  // profile itself is checked (deleted, edited or capped by the policy).
  const nextSelection = page
    ? selectRecordingProfile({ state, page, requestedProfileId: runtime.profile.request })
    : reselectStartedProfile(started, state);
  const next = nextSelection
    ? await buildSessionProfileSnapshot(runtime, nextSelection, enterprisePolicy)
    : null;

  // The session may have stopped or a newer request may have landed while this one was loading.
  if (!isProfileRequestCurrent(runtime, generation)) {
    return;
  }

  const reason = detectProfileChange({
    started: {
      selection: started,
      profileConfig: runtime.profile.profileConfig,
      effectiveConfig: runtime.config
    },
    next,
    startedProfileExists: state.catalog.some((profile) => profile.id === started.profile.id)
  });

  if (reason) {
    await cancelSessionForProfileChange(
      runtime,
      buildProfileCancellation({
        reason,
        trigger,
        at: Date.now(),
        started,
        next: nextSelection
      })
    );
  }
}

/** The recorder configs a selection would run with in this session. */
async function buildSessionProfileSnapshot(
  runtime: SessionRuntime,
  selection: ProfileSelection,
  enterprisePolicy: EnterpriseRecorderPolicy
): Promise<SessionProfileSnapshot> {
  const profileConfig = buildProfileRecorderConfig({
    mode: runtime.mode,
    profile: selection.profile,
    visualCapture: runtime.profile.visualCapture
  });
  const effectiveConfig = applyEnterprisePolicyToRecorderConfig(
    withSessionCapturePolicy(profileConfig, {
      tabId: runtime.tabId,
      origin: runtime.scopeOrigin ?? "",
      startedAt: runtime.startedAt
    }),
    enterprisePolicy
  );

  return { selection, profileConfig, effectiveConfig };
}

/**
 * Records why the profile changed (`meta.config.profileCancel`), then stops the session like the
 * Stop button does: the data stays for export or deletion. The badge and the popup tell the user.
 */
async function cancelSessionForProfileChange(
  runtime: SessionRuntime,
  cancellation: ProfileCancellation
): Promise<void> {
  runtime.profile = { ...runtime.profile, cancellation, cancellationAcknowledged: false };
  ingestRawEvent({
    source: "system",
    rawType: "config",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: cancellation.at,
    mono: monotonicTime(),
    payload: {
      ...runtime.config,
      profile: cancellation.started,
      profileCancel: cancellation
    }
  });
  console.warn(
    `[WebBlackbox] recording ${runtime.sid} stopped: profile changed (${cancellation.reason})`
  );

  // Stopping updates the badge to `!` while the notice is unread.
  await stopSession(runtime.tabId);
}

/**
 * REC while anything records, otherwise `!` while a profile-change notice is unread, otherwise
 * no badge.
 */
async function refreshActionBadge(): Promise<void> {
  if (sessionRegistry.tabCount() > 0) {
    await setRecordingBadge();
    return;
  }

  const unread = [...sessionRegistry.sidRuntimes()].some(
    (runtime) => runtime.profile.cancellation && !runtime.profile.cancellationAcknowledged
  );

  if (!unread) {
    await setIdleBadge();
    return;
  }

  await chromeApi?.action?.setBadgeText({ text: "!" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#b35c00" }).catch(() => undefined);
}

async function acknowledgeProfileCancel(sid: string): Promise<void> {
  const runtime = sessionRegistry.getBySid(sid);

  if (!runtime?.profile.cancellation || runtime.profile.cancellationAcknowledged) {
    return;
  }

  runtime.profile = { ...runtime.profile, cancellationAcknowledged: true };
  pushSessionList();
  await refreshActionBadge();
  // A later worker restores the acknowledged notice, not the unread one.
  await rememberStoppedSession(runtime);
}

function resolveSessionExportPolicy(runtime: SessionRuntime, policy: ExportPolicy): ExportPolicy {
  if (runtime.mode !== "full" || !runtime.config.capturePolicy) {
    return policy;
  }

  // A mid-session switch must not drop visuals recorded while an earlier profile allowed them.
  const { visualsCaptured } = runtime.profile;

  return {
    ...policy,
    includeScreenshots: visualsCaptured.screenshots,
    includeScreenRecordings: visualsCaptured.screenRecordings
  };
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

  if (shouldSkipFullModeContentRawEvent(runtime, rawEvent)) {
    return;
  }

  if (rawEvent.source === "content" && rawEvent.rawType === SCRIPT_RAW_TYPE) {
    recordScriptSourceMap(runtime, readContentScriptRecord(rawEvent.payload));
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

  if (runtime.mode === "full" && shouldCaptureActionScreenshot(nextRawEvent, runtime)) {
    runtime.lastActionScreenshotMono = nextRawEvent.mono;
    enqueue(
      runtime,
      async () => {
        await captureScreenshot(runtime, `action:${nextRawEvent.rawType}`);
      },
      { bestEffort: true }
    );
  }

  runtime.recorder.ingest(nextRawEvent);
}

function shouldAllowStopDrainContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  // Only while the stop drains: a snapshot that arrives after the drain (the session may already
  // be exported and deleted) would leave its blob behind in the pipeline's storage.
  return (
    rawEvent.source === "content" &&
    rawEvent.sid === runtime.sid &&
    runtime.stopDrained !== true &&
    STOP_DRAIN_CONTENT_RAW_TYPES.has(rawEvent.rawType)
  );
}

function shouldSkipFullModeContentRawEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  const categories = runtime.config.capturePolicy?.categories;

  return (
    runtime.mode === "full" &&
    rawEvent.source === "content" &&
    SKIPPED_FULL_MODE_CONTENT_RAW_TYPES.has(rawEvent.rawType) &&
    !(categories && isPageEventKeptInFullMode(rawEvent.rawType, categories))
  );
}

function shouldMaterializeLiteContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): boolean {
  const categories = runtime.config.capturePolicy?.categories;
  const isKeptInFullMode =
    categories !== undefined && isPageEventKeptInFullMode(rawEvent.rawType, categories);

  if (runtime.mode !== "lite" && !isKeptInFullMode) {
    return false;
  }

  if (rawEvent.source !== "content") {
    return false;
  }

  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return false;
  }

  if (rawEvent.rawType === "screenshot") {
    return typeof payload.dataUrl === "string" && payload.dataUrl.length > 0;
  }

  if (rawEvent.rawType === "snapshot") {
    return typeof payload.html === "string" && payload.html.length > 0;
  }

  // Storage snapshots are always normalized to what the capture policy allows.
  if (
    rawEvent.rawType === "localStorageSnapshot" ||
    rawEvent.rawType === "indexedDbSnapshot" ||
    rawEvent.rawType === "cookieSnapshot"
  ) {
    return true;
  }

  if (rawEvent.rawType === "networkBody") {
    return (
      (typeof payload.reqId === "string" || typeof payload.requestId === "string") &&
      typeof payload.body === "string"
    );
  }

  return false;
}

async function materializeLiteContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  if (rawEvent.rawType === "screenshot") {
    return materializeLiteScreenshot(runtime, rawEvent);
  }

  if (rawEvent.rawType === "snapshot") {
    return materializeLiteDomSnapshot(runtime, rawEvent);
  }

  if (
    rawEvent.rawType === "localStorageSnapshot" ||
    rawEvent.rawType === "indexedDbSnapshot" ||
    rawEvent.rawType === "cookieSnapshot"
  ) {
    // Details stay inline (never in blobs) so the recorder's redactor and policy checks see them.
    return materializeLiteRawEvent(rawEvent, {
      config: runtime.config,
      putBlob: (mime, bytes) => runtime.pipeline.putBlob(mime, bytes)
    });
  }

  if (rawEvent.rawType === "networkBody") {
    return materializeLiteNetworkBody(runtime, rawEvent);
  }

  return rawEvent;
}

async function materializeLiteScreenshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const dataUrl = asString(payload?.dataUrl);

  if (!payload || !dataUrl || dataUrl.length > LITE_SCREENSHOT_MAX_DATA_URL_LENGTH) {
    return null;
  }

  const decoded = decodeScreenshotDataUrl(dataUrl);

  if (
    !decoded ||
    decoded.bytes.byteLength === 0 ||
    decoded.bytes.byteLength > LITE_SCREENSHOT_MAX_BYTES
  ) {
    return null;
  }

  const shotId = await runtime.pipeline.putBlob(decoded.mime, decoded.bytes);
  const width = normalizePositiveInt(payload.w) ?? normalizePositiveInt(payload.width);
  const height = normalizePositiveInt(payload.h) ?? normalizePositiveInt(payload.height);
  const quality = normalizePositiveInt(payload.quality);
  const reason = asString(payload.reason) ?? undefined;
  const viewport = normalizeScreenshotViewport(payload.viewport);
  const pointer = normalizeScreenshotPointer(payload.pointer);
  const format = decoded.format;

  return {
    ...rawEvent,
    payload: {
      shotId,
      format,
      w: width,
      h: height,
      quality: format === "webp" ? quality : undefined,
      size: decoded.bytes.byteLength,
      reason,
      viewport,
      pointer
    }
  };
}

async function materializeLiteDomSnapshot(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);
  const html = asString(payload?.html);

  if (!payload || !html) {
    return null;
  }

  const encoded = encodeTextWithByteLimit(html, LITE_DOM_SNAPSHOT_MAX_BYTES);
  const contentHash = await runtime.pipeline.putBlob("text/html", encoded.bytes);
  const snapshotId = asString(payload.snapshotId) ?? `D-${Math.round(rawEvent.mono)}`;
  const nodeCount = normalizeNonNegativeInt(payload.nodeCount);
  const reason = asString(payload.reason) ?? undefined;
  const htmlLength = normalizeNonNegativeInt(payload.htmlLength) ?? html.length;
  const truncated = payload.truncated === true || encoded.truncated;

  return {
    ...rawEvent,
    payload: {
      snapshotId,
      contentHash,
      source: "html",
      nodeCount,
      reason,
      htmlLength,
      truncated
    }
  };
}

async function materializeLiteNetworkBody(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  const payload = asRecord(rawEvent.payload);

  if (!payload) {
    return null;
  }

  const reqId = asString(payload.reqId) ?? asString(payload.requestId);
  const body = asString(payload.body);
  const encoding = asString(payload.encoding) ?? "utf8";
  const url = asString(payload.url) ?? "";
  const mimeType = normalizeMimeType(asString(payload.mimeType));

  if (!reqId || !body || (encoding !== "utf8" && encoding !== "base64")) {
    return null;
  }

  const captureRule = resolveLiteBodyCaptureRule(runtime, url, mimeType);

  if (!captureRule.enabled || !isMimeAllowed(captureRule.mimeAllowlist, mimeType)) {
    return null;
  }

  const rules = runtime.config.redaction;
  let bytes: Uint8Array;
  let redacted = payload.redacted === true;

  if (encoding === "utf8") {
    const redaction = maskBodyText(body, rules, LITE_BODY_REDACTED_TOKEN);
    redacted = redacted || redaction.redacted;
    bytes = new TextEncoder().encode(redaction.value);
  } else {
    const redaction = maskBodyBytes(decodeBase64(body), rules, {
      mimeType,
      redactionToken: LITE_BODY_REDACTED_TOKEN
    });
    redacted = redacted || redaction.redacted;
    bytes = redaction.bytes;
  }

  if (bytes.byteLength === 0) {
    return null;
  }

  const size = normalizeNonNegativeInt(payload.size) ?? bytes.byteLength;
  const truncatedByInput = payload.truncated === true;
  const maxBytes = captureRule.maxBytes;
  const truncatedByLimit = bytes.byteLength > maxBytes;
  const sampledBytes = truncatedByLimit ? bytes.slice(0, maxBytes) : bytes;
  const contentHash = await runtime.pipeline.putBlob(
    mimeType ?? "application/octet-stream",
    sampledBytes
  );

  return {
    ...rawEvent,
    payload: {
      reqId,
      requestId: reqId,
      contentHash,
      mimeType,
      size,
      sampledSize: sampledBytes.byteLength,
      truncated: truncatedByInput || truncatedByLimit || sampledBytes.byteLength < size,
      redacted
    }
  };
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

function shouldCaptureActionScreenshot(
  rawEvent: RawRecorderEvent,
  runtime: SessionRuntime
): boolean {
  if (rawEvent.source !== "content") {
    return false;
  }

  if (!ACTION_SCREENSHOT_RAW_TYPES.has(rawEvent.rawType)) {
    return false;
  }

  if (runtime.config.capturePolicy?.categories.screenshots === "off") {
    return false;
  }

  if (rawEvent.mono - runtime.lastActionScreenshotMono < SCREENSHOT_ACTION_COOLDOWN_MS) {
    return false;
  }

  if (runtime.queueDepth >= Math.floor(BEST_EFFORT_QUEUE_MAX_PENDING / 3)) {
    return false;
  }

  return true;
}

function trackSessionCounters(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  runtime.capturedEventCount += 1;

  if (event.type === "error.exception" || event.type === "error.unhandledrejection") {
    runtime.capturedErrorCount += 1;
    sessionListPush.schedule();
    return;
  }

  if (runtime.capturedEventCount % 50 === 0) {
    sessionListPush.schedule();
  }
}

function evaluatePerformanceBudget(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  const budget = runtime.performanceBudget;
  let updated = false;

  if (event.type === "perf.vitals") {
    const lcpMs = readLcpFromVitalsEvent(event.data);

    if (lcpMs !== null && lcpMs >= budget.lcpWarnMs) {
      updated =
        registerPerformanceBudgetBreach(runtime, "lcp", `LCP ${Math.round(lcpMs)}ms`) || updated;
    }
  }

  if (event.type === "network.response") {
    const { duration, failed } = extractPerformanceBudgetNetworkSample(event.data);

    runtime.networkBudgetSample.total += 1;

    if (failed) {
      runtime.networkBudgetSample.failed += 1;
    }

    if (typeof duration === "number" && duration >= budget.requestWarnMs) {
      updated =
        registerPerformanceBudgetBreach(
          runtime,
          "slow-request",
          `Slow request ${Math.round(duration)}ms`
        ) || updated;
    }

    if (runtime.networkBudgetSample.total >= PERFORMANCE_BUDGET_ERROR_RATE_MIN_SAMPLES) {
      const errorRatePct =
        (runtime.networkBudgetSample.failed / runtime.networkBudgetSample.total) * 100;

      if (errorRatePct >= budget.errorRateWarnPct) {
        updated =
          registerPerformanceBudgetBreach(
            runtime,
            "error-rate",
            `Error rate ${errorRatePct.toFixed(1)}%`
          ) || updated;
      }
    }
  }

  if (updated) {
    sessionListPush.schedule();
  }
}

function readLcpFromVitalsEvent(payload: unknown): number | null {
  const record = asRecord(payload);
  const metric = asString(record?.metric) ?? asString(record?.name);

  if (
    metric &&
    metric !== "largest-contentful-paint" &&
    metric !== "largest-contentful-paint-render-time" &&
    metric !== "largest-contentful-paint-load-time" &&
    metric !== "lcp"
  ) {
    return null;
  }

  const value = asFiniteNumber(record?.value);
  const startTime = asFiniteNumber(record?.startTime);
  const duration = asFiniteNumber(record?.duration);
  const candidate = Math.max(
    value ?? Number.NEGATIVE_INFINITY,
    startTime ?? Number.NEGATIVE_INFINITY,
    duration ?? Number.NEGATIVE_INFINITY
  );

  return Number.isFinite(candidate) ? candidate : null;
}

function registerPerformanceBudgetBreach(
  runtime: SessionRuntime,
  key: string,
  detail: string
): boolean {
  const now = Date.now();
  const lastBreachAt = runtime.lastBudgetBreachAt.get(key) ?? Number.NEGATIVE_INFINITY;

  if (now - lastBreachAt < PERFORMANCE_BUDGET_BREACH_COOLDOWN_MS) {
    return false;
  }

  runtime.lastBudgetBreachAt.set(key, now);
  runtime.budgetAlertCount += 1;
  console.info("[WebBlackbox] performance budget breach", {
    sid: runtime.sid,
    tabId: runtime.tabId,
    key,
    detail
  });

  if (runtime.performanceBudget.autoFreezeOnBreach) {
    handleFreezeNotice(runtime, "perf");
  }

  return true;
}

function enqueuePipelineEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  runtime.pipelineEventBuffer.push(event);

  if (runtime.pipelineEventBuffer.length >= PIPELINE_BATCH_MAX_EVENTS) {
    queuePipelineBatchFlush(runtime);
    return;
  }

  if (runtime.pipelineFlushTimer !== null || runtime.pipelineFlushQueued) {
    return;
  }

  runtime.pipelineFlushTimer = setTimeout(() => {
    runtime.pipelineFlushTimer = null;
    queuePipelineBatchFlush(runtime);
  }, PIPELINE_BATCH_FLUSH_MS);
}

function queuePipelineBatchFlush(runtime: SessionRuntime): void {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  if (runtime.pipelineFlushQueued || runtime.pipelineEventBuffer.length === 0) {
    return;
  }

  runtime.pipelineFlushQueued = true;

  enqueue(runtime, async () => {
    try {
      await drainPipelineBufferBatches(runtime, "queue");
    } finally {
      runtime.pipelineFlushQueued = false;

      if (runtime.pipelineEventBuffer.length > 0 && !runtime.stopping) {
        queuePipelineBatchFlush(runtime);
      }
    }
  });
}

async function flushBufferedPipelineEvents(runtime: SessionRuntime): Promise<void> {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  if (runtime.pipelineEventBuffer.length === 0 && !runtime.pipelineFlushQueued) {
    return;
  }

  await enqueueWithResult(runtime, async () => {
    await drainPipelineBufferBatches(runtime, "drain");
  });
}

async function drainPipelineBufferBatches(
  runtime: SessionRuntime,
  reason: "queue" | "drain"
): Promise<void> {
  let flushed = 0;

  while (runtime.pipelineEventBuffer.length > 0) {
    const batchSize = Math.min(
      runtime.pipelineEventBuffer.length,
      PIPELINE_BATCH_DRAIN_CHUNK_EVENTS
    );
    const batch = runtime.pipelineEventBuffer.slice(0, batchSize);

    if (batch.length === 0) {
      break;
    }

    // The pipeline serializes each event once; its byte count is the session size.
    runtime.capturedSizeBytes += await runtime.pipeline.ingestBatch(batch);
    runtime.pipelineEventBuffer.splice(0, batch.length);
    flushed += batch.length;

    if (runtime.pipelineEventBuffer.length > 0) {
      await wait(0);
    }
  }

  if (shouldLogPerf() && flushed > 0) {
    console.info("[WebBlackbox][perf] pipeline buffer flushed", {
      sid: runtime.sid,
      reason,
      flushed,
      queueDepth: runtime.queueDepth,
      stopping: runtime.stopping
    });
  }
}

async function ensureOffscreenPortReady(): Promise<PortLike> {
  await orphanedOffscreenCleanup;
  return offscreenPortConnector.ensurePort();
}

function handleOffscreenRuntimeMessage(rawMessage: unknown, port: PortLike): boolean {
  if (port.name !== PORT_NAMES.offscreen) {
    return false;
  }

  const message = offscreenClient.receive(rawMessage);

  if (message) {
    handleOffscreenEvent(message);
  }

  // Nothing on the offscreen port is meant for the inbound router.
  return true;
}

function handleOffscreenEvent(message: OffscreenEventMessage): void {
  switch (message.kind) {
    case "offscreen.ready":
      notifyOffscreenPipelineStatus();
      return;
    case "offscreen.keepalive":
      return;
    case "offscreen.screen-recording-chunk":
      handleOffscreenScreenRecordingChunk(message);
      return;
    case "offscreen.screen-recording-ended":
      void handleOffscreenScreenRecordingEnded(message).catch((error) => {
        console.warn("[WebBlackbox] failed to finalize screen recording", error);
      });
      return;
    case "offscreen.screen-recording-error":
      handleOffscreenScreenRecordingError(message);
      return;
  }
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
    notifyOffscreenPipelineStatus();
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

async function attachCdp(runtime: SessionRuntime): Promise<void> {
  let router: CdpRouter | null = null;

  try {
    router = createCdpRouter(createChromeDebuggerTransport());

    const unsubscribeEvent = router.onEvent((event) => {
      // Raw CDP params go to the recorder, whose normalizer allowlists fields and gates bodies.
      const cdpPayload = event.params ?? {};

      if (event.method === "HeapProfiler.addHeapSnapshotChunk") {
        const payload = asRecord(cdpPayload);
        const chunk = typeof payload?.chunk === "string" ? payload.chunk : undefined;

        if (chunk && runtime.heapSnapshotCapture) {
          const chunkBytes = new TextEncoder().encode(chunk).byteLength;
          const nextBytes = runtime.heapSnapshotCapture.bytes + chunkBytes;

          if (nextBytes <= HEAP_SNAPSHOT_MAX_BYTES) {
            runtime.heapSnapshotCapture.chunks.push(chunk);
            runtime.heapSnapshotCapture.bytes = nextBytes;
          } else {
            runtime.heapSnapshotCapture.truncated = true;
          }
        }
      }

      // One event per parsed script (eval and extension code included): handled inline instead
      // of through the recorder or the best-effort follow-up queue.
      if (event.method === "Debugger.scriptParsed") {
        recordScriptSourceMap(runtime, scriptRecordFromScriptParsed(cdpPayload));
        return;
      }

      const rawEvent: RawRecorderEvent = {
        source: "cdp",
        rawType: event.method,
        tabId: runtime.tabId,
        sid: runtime.sid,
        t: Date.now(),
        mono: monotonicTime(),
        cdpSessionId: event.sessionId,
        payload: cdpPayload
      };

      ingestCdpRawEvent(
        runtime,
        event.method === "Network.requestWillBeSent"
          ? prepareCdpRequestEvent(runtime, rawEvent)
          : rawEvent
      );

      if (!runtime.stopping) {
        trackFullModeNetworkEvent(runtime, event.method, asRecord(cdpPayload), event.sessionId);
      }

      if (!FULL_MODE_FOLLOWUP_METHODS.has(event.method)) {
        return;
      }

      enqueue(
        runtime,
        async () => {
          await processFullModeEvent(runtime, event.method, event.params ?? {});
        },
        { bestEffort: !FULL_MODE_REQUIRED_FOLLOWUP_METHODS.has(event.method) }
      );
    });

    const unsubscribeDetach = router.onDetach((event) => {
      if (event.tabId === runtime.tabId) {
        void stopSession(runtime.tabId);
      }
    });

    runtime.removeCdpListeners.push(unsubscribeEvent, unsubscribeDetach);

    await router.attach(runtime.tabId);
    // Set before the domains are enabled: their first events already read bodies through it.
    runtime.cdpRouter = router;
    runtime.enabledCdpSessions.clear();
    await router.enableBaseline(runtime.tabId);
    runtime.enabledCdpSessions.add("root");
    await router.enableAutoAttach(runtime.tabId);
    await router.send({ tabId: runtime.tabId }, "DOMStorage.enable").catch(() => undefined);
    await router.send({ tabId: runtime.tabId }, "Performance.enable").catch(() => undefined);
    await enableScriptDebugger(runtime, router, { tabId: runtime.tabId });

    runtime.cdpRouter = router;

    enqueue(
      runtime,
      async () => {
        await captureFullModeArtifacts(runtime, "session-start");
      },
      { bestEffort: true }
    );

    const normalizedScreenshotIntervalMs = normalizeOptionalSamplingInterval(
      runtime.config.sampling.screenshotIdleMs,
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    );

    if (normalizedScreenshotIntervalMs > 0) {
      const screenshotIntervalMs = Math.max(
        FULL_MODE_MIN_SCREENSHOT_INTERVAL_MS,
        normalizedScreenshotIntervalMs
      );

      runtime.screenshotInterval = globalThis.setInterval(() => {
        enqueue(
          runtime,
          async () => {
            await captureScreenshot(runtime, "interval");
          },
          { bestEffort: true }
        );
      }, screenshotIntervalMs);
    }
  } catch (error) {
    await cleanupCdpInstrumentation(runtime, router);
    console.warn("[WebBlackbox] failed to attach debugger", error);
  }
}

async function processFullModeEvent(
  runtime: SessionRuntime,
  method: string,
  params: unknown
): Promise<void> {
  if (runtime.stopping) {
    return;
  }

  const payload = asRecord(params);

  if (method === "Target.attachedToTarget") {
    const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

    if (childSessionId) {
      await primeChildCdpSession(runtime, childSessionId);
    }

    return;
  }

  if (method === "Target.detachedFromTarget") {
    const childSessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;

    if (childSessionId) {
      runtime.enabledCdpSessions.delete(childSessionId);
    }

    return;
  }

  if (method === "Runtime.exceptionThrown" || method === "Network.loadingFailed") {
    if (shouldCaptureIncidentArtifacts(runtime)) {
      await captureIncidentArtifacts(runtime, method);
    }

    return;
  }
}

async function primeChildCdpSession(
  runtime: SessionRuntime,
  childSessionId: string
): Promise<void> {
  if (!runtime.cdpRouter || runtime.enabledCdpSessions.has(childSessionId)) {
    return;
  }

  runtime.enabledCdpSessions.add(childSessionId);

  const primed = await primeChildSession(
    runtime.cdpRouter,
    runtime.tabId,
    childSessionId,
    CHILD_SESSION_PRIME_TIMEOUT_MS
  );

  if (!primed) {
    runtime.enabledCdpSessions.delete(childSessionId);
    return;
  }

  // Bounded like the priming: a child that is gone may never answer, and this runs on the
  // session's serial queue. enableScriptDebugger logs its own failures.
  await withCdpCommandTimeout(
    enableScriptDebugger(runtime, runtime.cdpRouter, {
      tabId: runtime.tabId,
      sessionId: childSessionId
    }),
    CHILD_SESSION_PRIME_TIMEOUT_MS
  );
}

function resolveRuntimeSourceMapCapture(runtime: SessionRuntime): SourceMapCapture {
  return resolveSourceMapCapture(runtime.profile.selection.profile, runtime.mode);
}

/** Lite pages scan their own scripts for map references when the profile asks for it. */
function toScriptScanStatus(runtime: SessionRuntime): { scriptSourceMaps?: true } {
  return runtime.mode === "lite" && resolveRuntimeSourceMapCapture(runtime).mode !== "off"
    ? { scriptSourceMaps: true }
    : {};
}

/**
 * Turns on `Debugger.scriptParsed` (which also reports scripts loaded before recording started)
 * when the profile records source maps. Pauses are skipped so `debugger;` statements and
 * breakpoints never stop the page.
 */
async function enableScriptDebugger(
  runtime: SessionRuntime,
  router: CdpRouter,
  target: { tabId: number; sessionId?: string }
): Promise<void> {
  if (resolveRuntimeSourceMapCapture(runtime).mode === "off") {
    return;
  }

  try {
    await router.send(target, "Debugger.enable", {
      maxScriptsCacheSize: DEBUGGER_SCRIPT_CACHE_BYTES
    });
    await router.send(target, "Debugger.setSkipAllPauses", { skip: true });
  } catch (error) {
    console.warn("[WebBlackbox] failed to enable script source map capture", {
      sid: runtime.sid,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** Lite scanner records arrive as content events with full URLs. */
function readContentScriptRecord(payload: unknown): RawScriptRecord | null {
  const row = asRecord(payload);
  const url = typeof row?.url === "string" ? row.url : "";
  const sourceMapUrl = typeof row?.sourceMapUrl === "string" ? row.sourceMapUrl : "";
  const origin = row?.origin === "header" ? "header" : row?.origin === "comment" ? "comment" : null;

  return url && sourceMapUrl && origin ? { url, sourceMapUrl, origin } : null;
}

/**
 * Records a script's source map reference once per session and, when the profile embeds maps,
 * stores the map as a blob and records it in a follow-up event.
 */
function recordScriptSourceMap(runtime: SessionRuntime, record: RawScriptRecord | null): void {
  if (!record || runtime.stopping) {
    return;
  }

  const capture = resolveRuntimeSourceMapCapture(runtime);

  if (capture.mode === "off" || !runtime.scriptSourceMaps.markRecorded(record)) {
    return;
  }

  ingestScriptRecord(runtime, record);

  if (capture.mode !== "embed" || !runtime.scriptSourceMaps.reserveEmbed(record)) {
    return;
  }

  // Fetched outside the session queue (which also carries pipeline flushes and CDP follow-ups),
  // so slow or large maps never hold up capture; only the blob write is queued.
  void runtime
    .scriptSourceMapFetches(() => embedScriptSourceMap(runtime, record, capture.maxMapBytes))
    .catch((error: unknown) => {
      console.warn("[WebBlackbox] failed to embed source map", {
        sid: runtime.sid,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

async function embedScriptSourceMap(
  runtime: SessionRuntime,
  record: RawScriptRecord,
  maxMapBytes: number
): Promise<void> {
  if (runtime.stopping) {
    return;
  }

  const tracker = runtime.scriptSourceMaps;
  const result = await loadSourceMapForEmbedding(record, {
    maxBytes: Math.min(maxMapBytes, tracker.remainingEmbedBytes())
  });

  // A late result must not land in a later session on the same tab.
  if (runtime.stopping) {
    return;
  }

  if (!result.ok) {
    ingestScriptRecord(runtime, { ...record, mapError: result.error });
    return;
  }

  if (!tracker.tryAddEmbeddedBytes(result.bytes.byteLength)) {
    ingestScriptRecord(runtime, { ...record, mapError: "session source map budget exhausted" });
    return;
  }

  enqueue(runtime, async () => {
    if (runtime.stopping) {
      return;
    }

    const contentHash = await runtime.pipeline.putBlob("application/json", result.bytes);

    ingestScriptRecord(runtime, {
      ...record,
      map: { contentHash, size: result.bytes.byteLength }
    });
  });
}

function ingestScriptRecord(
  runtime: SessionRuntime,
  payload: RawScriptRecord & { map?: { contentHash: string; size: number }; mapError?: string }
): void {
  ingestRawEvent({
    source: "system",
    rawType: SCRIPT_RAW_TYPE,
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload
  });
}

function isFullBodyCaptureEnabled(runtime: SessionRuntime): boolean {
  return (
    runtime.mode === "full" && runtime.config.capturePolicy?.categories.network === "body-allowlist"
  );
}

function createFullBodyCapture(getRuntime: () => SessionRuntime): FullBodyCapture {
  return new FullBodyCapture({
    isEnabled: () => isFullBodyCaptureEnabled(getRuntime()),
    resolveRule: (url, mimeType) => resolveFullBodyCaptureRule(getRuntime(), url, mimeType),
    readResponseBody: (requestId, sessionId) =>
      readCdpForBodies(getRuntime(), sessionId, "Network.getResponseBody", { requestId }),
    storeBody: (response, read, rule, mimeType) =>
      storeFullModeResponseBody(getRuntime(), response, read, rule.maxBytes, mimeType),
    emitSkip: (payload) => {
      const runtime = getRuntime();
      ingestCdpRawEvent(runtime, {
        source: "system",
        rawType: BODY_SKIPPED_RAW_TYPE,
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload
      });
    }
  });
}

/**
 * CDP reads for body capture. Unlike `sendCdpCommand` they still run while the session stops
 * (stop drains pending bodies before the debugger detaches) and report the CDP error text.
 */
async function readCdpForBodies<TResult>(
  runtime: SessionRuntime,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<CdpCommandOutcome<TResult>> {
  if (!runtime.cdpRouter) {
    return { ok: false, error: "debugger detached" };
  }

  const target = sessionId ? { tabId: runtime.tabId, sessionId } : { tabId: runtime.tabId };
  return withCdpCommandTimeout(runtime.cdpRouter.send<TResult>(target, method, params), timeoutMs);
}

async function storeFullModeResponseBody(
  runtime: SessionRuntime,
  response: FinishedResponse,
  read: ReadBody,
  maxBytes: number,
  mimeType: string | undefined
): Promise<number> {
  const transformed = transformResponseBodyForCapture({
    body: read.body,
    base64Encoded: read.base64Encoded,
    redaction: runtime.config.redaction,
    maxBytes,
    mimeType,
    redactionToken: LITE_BODY_REDACTED_TOKEN,
    decodeBase64
  });
  const rawMimeType = response.meta?.mimeType;
  const hash = await runtime.pipeline.putBlob(
    rawMimeType ?? "application/octet-stream",
    transformed.sampledBytes
  );

  ingestCdpRawEvent(runtime, {
    source: "system",
    rawType: "cdp.network.body",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      reqId: response.requestId,
      contentHash: hash,
      mimeType: rawMimeType,
      size: transformed.originalBytes.byteLength,
      sampledSize: transformed.sampledBytes.byteLength,
      redacted: transformed.redacted,
      truncated: transformed.truncated
    }
  });

  return transformed.sampledBytes.byteLength;
}

/**
 * Keeps request ids and response metadata for body capture, inline on every CDP event: a dropped
 * bookkeeping task would lose the body silently.
 */
function trackFullModeNetworkEvent(
  runtime: SessionRuntime,
  method: string,
  payload: Record<string, unknown> | null,
  sessionId: string | undefined
): void {
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;

  if (!requestId) {
    return;
  }

  const metaKey = buildRequestMetaKey(requestId, sessionId);

  if (method === "Network.requestWillBeSent") {
    runtime.fullBodyCapture.onRequestWillBeSent(requestId, sessionId);
    return;
  }

  if (method === "Network.responseReceived") {
    recordScriptSourceMap(runtime, scriptRecordFromResponse(payload));
    const response = asRecord(payload?.response);
    upsertRequestMeta(runtime.requestMeta, metaKey, {
      url: typeof response?.url === "string" ? response.url : undefined,
      mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
      status: typeof response?.status === "number" ? response.status : undefined,
      resourceType: typeof payload?.type === "string" ? payload.type : undefined,
      // Bytes received when the response arrived: its headers (the body follows).
      headerBytes: asFiniteNumber(response?.encodedDataLength) ?? undefined
    });
    runtime.fullBodyCapture.onResponseReceived({
      requestId,
      sessionId,
      meta: getRequestMeta(runtime.requestMeta, metaKey)
    });
    return;
  }

  if (method === "Network.loadingFinished") {
    const encodedDataLength = asFiniteNumber(payload?.encodedDataLength);
    runtime.fullBodyCapture.onLoadingFinished({
      requestId,
      sessionId,
      encodedDataLength:
        encodedDataLength !== null && encodedDataLength >= 0 ? encodedDataLength : undefined,
      meta: getRequestMeta(runtime.requestMeta, metaKey)
    });
    deleteRequestMeta(runtime.requestMeta, metaKey);
    return;
  }

  if (method === "Network.loadingFailed") {
    runtime.fullBodyCapture.onLoadingFailed(requestId, sessionId);
    deleteRequestMeta(runtime.requestMeta, metaKey);
  }
}

/**
 * Ingests a CDP-side raw event in arrival order. While a request body CDP left out is being read,
 * later events wait behind it, so the request still comes before its response.
 */
function ingestCdpRawEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent | Promise<RawRecorderEvent>
): void {
  if (runtime.cdpIngestBacklog === 0 && !(rawEvent instanceof Promise)) {
    ingestRawEvent(rawEvent);
    return;
  }

  const arrivedBeforeStop = !runtime.stopping;
  runtime.cdpIngestBacklog += 1;
  runtime.cdpIngestChain = runtime.cdpIngestChain
    .then(async () => {
      ingestRawEvent(await rawEvent, { arrivedBeforeStop });
    })
    .catch((error) => {
      console.warn("[WebBlackbox] failed to ingest a CDP event", error);
    })
    .finally(() => {
      runtime.cdpIngestBacklog = Math.max(0, runtime.cdpIngestBacklog - 1);
    });
}

/** The `requestWillBeSent` raw event, with a body CDP did not inline read when bodies are on. */
function prepareCdpRequestEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): RawRecorderEvent | Promise<RawRecorderEvent> {
  const payload = asRecord(rawEvent.payload);

  if (!isFullBodyCaptureEnabled(runtime) || !payload || !needsRequestPostData(payload)) {
    return rawEvent;
  }

  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;

  if (!requestId) {
    return rawEvent;
  }

  // Events wait behind pending reads; past this backlog the body is recorded as skipped instead.
  if (runtime.cdpIngestBacklog >= FULL_MODE_CDP_INGEST_MAX_BACKLOG) {
    const request = asRecord(payload.request) ?? {};
    return {
      ...rawEvent,
      payload: { ...payload, request: { ...request, postDataSkipped: "backlog" } }
    };
  }

  return completeRequestPostData(payload, () =>
    readCdpForBodies<{ postData?: string }>(
      runtime,
      rawEvent.cdpSessionId,
      "Network.getRequestPostData",
      { requestId },
      FULL_MODE_POST_DATA_TIMEOUT_MS
    )
  ).then((completed) => ({ ...rawEvent, payload: completed }));
}

function shouldCaptureIncidentArtifacts(runtime: SessionRuntime): boolean {
  if (runtime.stopping) {
    return false;
  }

  if (
    runtime.config.capturePolicy?.categories.screenshots === "off" &&
    runtime.config.capturePolicy?.categories.cdp !== "full"
  ) {
    return false;
  }

  const now = Date.now();

  if (now - runtime.lastIncidentCaptureAt < FULL_MODE_INCIDENT_CAPTURE_COOLDOWN_MS) {
    return false;
  }

  runtime.lastIncidentCaptureAt = now;
  return true;
}

async function captureIncidentArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
  await Promise.allSettled([
    captureScreenshot(runtime, reason),
    captureTraceMetrics(runtime, reason)
  ]);
}

function handleFreezeNotice(runtime: SessionRuntime, reason: FreezeReason): void {
  if (runtime.stopping) {
    return;
  }

  const now = Date.now();
  const lastNotifiedAt = runtime.lastFreezeNotices.get(reason) ?? Number.NEGATIVE_INFINITY;

  if (now - lastNotifiedAt < FREEZE_NOTICE_COOLDOWN_MS) {
    return;
  }

  runtime.lastFreezeNotices.set(reason, now);
  broadcast({ kind: "sw.freeze", sid: runtime.sid, reason });
  void setFreezeBadge();
}

async function captureFullModeArtifacts(runtime: SessionRuntime, reason: string): Promise<void> {
  const tasks: Array<Promise<void>> = [
    captureScreenshot(runtime, reason),
    captureTraceMetrics(runtime, reason)
  ];

  if (reason !== "session-start") {
    // The DOM comes from the page agent's raw snapshot (`dom: allow`), which masks blocked
    // selectors and field values; a CDP DOMSnapshot would carry both unmasked.
    tasks.push(captureStorageSnapshots(runtime, reason));
  } else if (runtime.config.capturePolicy?.categories.cookies === "allow") {
    // Cookie values at the start (and at stop) even when no incident triggers a snapshot.
    tasks.push(captureCookieValues(runtime, reason));
  }

  if (shouldCaptureAdvancedProfiles(reason)) {
    tasks.push(captureAdvancedProfiles(runtime, reason));
  }

  await Promise.allSettled(tasks);
}

async function captureScreenshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.screenshots === "off") {
    return;
  }

  const screenshot = await sendCdpCommand<{ data?: string }>(
    runtime,
    { tabId: runtime.tabId },
    "Page.captureScreenshot",
    {
      format: "webp",
      quality: 62,
      fromSurface: true
    }
  );

  if (!screenshot?.data) {
    return;
  }

  const bytes = decodeBase64(screenshot.data);
  const hash = await runtime.pipeline.putBlob("image/webp", bytes);
  const viewport = runtime.lastViewport;
  const pointer =
    runtime.lastPointer && Date.now() - runtime.lastPointer.t <= POINTER_STALE_MS
      ? runtime.lastPointer
      : null;

  ingestRawEvent({
    source: "system",
    rawType: "cdp.screen.screenshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      shotId: hash,
      format: "webp",
      quality: 62,
      w: viewport?.width,
      h: viewport?.height,
      viewport: viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            dpr: viewport.dpr
          }
        : undefined,
      pointer: pointer
        ? {
            x: pointer.x,
            y: pointer.y,
            t: pointer.t,
            mono: pointer.mono
          }
        : undefined,
      size: bytes.byteLength,
      reason
    }
  });
}

function shouldStartScreenRecording(runtime: SessionRuntime): boolean {
  return (
    runtime.mode === "full" && runtime.config.capturePolicy?.categories.screenRecordings === "allow"
  );
}

async function startScreenRecording(runtime: SessionRuntime): Promise<void> {
  if (!chromeApi?.tabCapture?.getMediaStreamId) {
    throw new Error("Chrome tabCapture API is unavailable for screen recording.");
  }

  if (runtime.screenRecording) {
    return;
  }

  const recordingId = createScreenRecordingId(runtime.sid);
  const startedAt = Date.now();
  const startedMono = monotonicTime();
  const streamId = await chromeApi.tabCapture.getMediaStreamId({
    targetTabId: runtime.tabId
  });

  if (!streamId) {
    throw new Error("Chrome did not grant a tab capture stream.");
  }

  const recording: ScreenRecordingRuntime = {
    recordingId,
    source: SCREEN_RECORDING_OFFSCREEN_SOURCE,
    startedAt,
    startedMono,
    mime: "video/webm",
    chunks: [],
    chunkCount: 0,
    sizeBytes: 0,
    stopPromise: null
  };
  runtime.screenRecording = recording;

  try {
    const result = await offscreenClient.request({
      op: "startScreenRecording",
      sid: runtime.sid,
      recordingId,
      streamId,
      source: SCREEN_RECORDING_OFFSCREEN_SOURCE
    });

    recording.mime = result.mime;
    recording.width = result.width;
    recording.height = result.height;
    recording.frameRate = result.frameRate;

    ingestRawEvent({
      source: "system",
      rawType: "screen.recording.start",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: startedAt,
      mono: startedMono,
      payload: {
        recordingId,
        source: result.source,
        mime: result.mime,
        width: result.width,
        height: result.height,
        frameRate: result.frameRate,
        audio: result.audio
      }
    });
  } catch (error) {
    ingestScreenRecordingError(runtime, recording, error, "start");
    runtime.screenRecording = null;
    throw error;
  }
}

async function stopScreenRecording(runtime: SessionRuntime, reason: string): Promise<void> {
  const recording = runtime.screenRecording;

  if (!recording) {
    return;
  }

  if (recording.stopPromise) {
    await recording.stopPromise;
    return;
  }

  recording.stopPromise = (async () => {
    const result = await offscreenClient.request({
      op: "stopScreenRecording",
      sid: runtime.sid,
      recordingId: recording.recordingId,
      reason
    });
    await finalizeScreenRecording(runtime, result);
  })();

  await recording.stopPromise;
}

/** The offscreen document has already stored the chunk; the worker records where it is. */
function handleOffscreenScreenRecordingChunk(message: ScreenRecordingChunkMessage): void {
  const runtime = sessionRegistry.getBySid(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime || !recording || recording.recordingId !== message.recordingId) {
    return;
  }

  const { chunkId, index, mime, size } = message;
  recording.chunks[index] = chunkId;
  recording.chunkCount = Math.max(recording.chunkCount, index + 1);
  recording.sizeBytes += size;

  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.chunk",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: recording.recordingId,
      chunkId,
      index,
      mime,
      size,
      startOffsetMs: message.startOffsetMs,
      endOffsetMs: message.endOffsetMs,
      durationMs: message.durationMs
    }
  });
}

async function handleOffscreenScreenRecordingEnded(
  message: ScreenRecordingEndedMessage
): Promise<void> {
  const runtime = sessionRegistry.getBySid(message.sid);

  if (!runtime?.screenRecording) {
    return;
  }

  await finalizeScreenRecording(runtime, message.result);
}

function handleOffscreenScreenRecordingError(message: ScreenRecordingErrorMessage): void {
  const runtime = sessionRegistry.getBySid(message.sid);
  const recording = runtime?.screenRecording;

  if (!runtime) {
    return;
  }

  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.error",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: message.recordingId ?? recording?.recordingId,
      name: message.name,
      message: message.message,
      stage: message.stage
    }
  });
}

async function finalizeScreenRecording(
  runtime: SessionRuntime,
  result: ScreenRecordingStopResult
): Promise<void> {
  const recording = runtime.screenRecording;

  if (!recording || recording.recordingId !== result.recordingId) {
    return;
  }

  const chunks = recording.chunks.filter(
    (chunk): chunk is string => typeof chunk === "string" && chunk.length > 0
  );

  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.end",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: recording.recordingId,
      mime: result.mime || recording.mime,
      chunks,
      chunkCount: chunks.length,
      size: recording.sizeBytes,
      durationMs: Math.max(0, Math.round(result.durationMs)),
      width: result.width ?? recording.width,
      height: result.height ?? recording.height,
      reason: result.reason
    }
  });

  runtime.screenRecording = null;
}

function ingestScreenRecordingError(
  runtime: SessionRuntime,
  recording: ScreenRecordingRuntime | null,
  error: unknown,
  stage: string
): void {
  ingestRawEvent({
    source: "system",
    rawType: "screen.recording.error",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      recordingId: recording?.recordingId,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      stage
    }
  });
}

function createScreenRecordingId(sid: string): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `VR-${sid}-${Date.now()}-${random}`;
}

const VISITED_PAGE_URLS_MAX = 20;

function rememberVisitedPageUrl(runtime: SessionRuntime, rawUrl: string): void {
  const [url] = rememberablePageUrl(rawUrl) ?? [];

  if (!url || runtime.visitedPageUrls.has(url)) {
    return;
  }

  if (runtime.visitedPageUrls.size >= VISITED_PAGE_URLS_MAX) {
    const oldest = runtime.visitedPageUrls.values().next().value;

    if (oldest !== undefined) {
      runtime.visitedPageUrls.delete(oldest);
    }
  }

  runtime.visitedPageUrls.add(url);
}

/**
 * `cookies: allow`: every cookie of the page with its value (HttpOnly ones too, which the page
 * cannot read), inline as `cookies` records so the recorder's cookie-name rules can mask values.
 */
async function captureCookieValues(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  // Sent directly (not through `sendCdpCommand`) so the snapshot at stop still runs. The pages
  // the tab showed only; Storage.getCookies would list every site in the browser.
  const urls = [...runtime.visitedPageUrls];
  const outcome = await withCdpCommandTimeout(
    runtime.cdpRouter.send<{ cookies?: unknown[] }>(
      { tabId: runtime.tabId },
      "Network.getCookies",
      urls.length > 0 ? { urls } : undefined
    ),
    CDP_ARTIFACT_TIMEOUT_MS
  );
  const result = outcome.ok ? outcome.value : undefined;

  if (!result?.cookies) {
    return;
  }

  const cookies = result.cookies.slice(0, FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS).flatMap((entry) => {
    const row = asRecord(entry);
    const name = asString(row?.name);

    if (!row || name === null || typeof row.value !== "string") {
      return [];
    }

    return [
      {
        name,
        ...capStorageValue(row.value),
        domain: asString(row.domain) ?? undefined,
        path: asString(row.path) ?? undefined,
        httpOnly: row.httpOnly === true,
        secure: row.secure === true,
        sameSite: asString(row.sameSite) ?? undefined,
        expires: typeof row.expires === "number" ? row.expires : undefined
      }
    ];
  });

  ingestRawEvent({
    source: "system",
    rawType: "cdp.storage.cookie.snapshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      reason,
      count: result.cookies.length,
      truncated: result.cookies.length > cookies.length,
      mode: "allow",
      redacted: false,
      cookies
    }
  });
}

async function captureStorageSnapshots(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  const policy = runtime.config.capturePolicy;

  // The page agent records localStorage and IndexedDB itself (inline, through the redactor);
  // the CDP snapshots below would duplicate them in blobs the redactor never sees. Cookie names
  // stay on CDP: `document.cookie` cannot see HttpOnly cookies.
  const pageRecordsStorage = !!policy && capturesPageStorageInFullMode(policy.categories);

  if (policy?.categories.cookies === "allow") {
    await captureCookieValues(runtime, reason);
  }

  const cookies =
    policy?.categories.cookies === "names-only"
      ? await sendCdpCommand<{ cookies?: unknown[] }>(
          runtime,
          { tabId: runtime.tabId },
          // The page's cookies only; Storage.getCookies would list every site in the browser.
          "Network.getCookies"
        )
      : null;

  if (cookies?.cookies) {
    const cookieNames = cookies.cookies
      .map((entry) => asString(asRecord(entry)?.name))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS);
    const bytes = new TextEncoder().encode(JSON.stringify(cookieNames));
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.cookie.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        hash,
        count: cookies.cookies.length,
        sampledCount: cookieNames.length,
        truncated: cookies.cookies.length > cookieNames.length,
        redacted: true,
        reason
      }
    });
  }

  const localStorageMode = pageRecordsStorage ? null : resolveLocalStorageSnapshotMode(policy);
  const localStorageData = localStorageMode
    ? await evaluateExpression(runtime, buildLocalStorageSnapshotExpression(localStorageMode))
    : null;

  if (typeof localStorageData === "string") {
    const bytes = new TextEncoder().encode(localStorageData);
    const hash = await runtime.pipeline.putBlob("application/json", bytes);
    const parsed = parseStorageSnapshotMeta(localStorageData);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.storage.local.snapshot",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        hash,
        count: parsed?.count,
        sampledCount: parsed?.sampledCount,
        truncated: parsed?.truncated,
        mode: localStorageMode,
        redacted: localStorageMode !== "allow",
        reason
      }
    });
  }

  const origin =
    !pageRecordsStorage && policy?.categories.indexedDb === "names-only"
      ? await evaluateExpression(runtime, "location.origin")
      : null;

  if (typeof origin === "string") {
    const dbNames = await sendCdpCommand<{ databaseNames?: string[] }>(
      runtime,
      { tabId: runtime.tabId },
      "IndexedDB.requestDatabaseNames",
      {
        securityOrigin: origin
      }
    );

    if (dbNames?.databaseNames) {
      const bytes = new TextEncoder().encode(JSON.stringify(dbNames.databaseNames));
      const hash = await runtime.pipeline.putBlob("application/json", bytes);

      ingestRawEvent({
        source: "system",
        rawType: "cdp.storage.idb.snapshot",
        sid: runtime.sid,
        tabId: runtime.tabId,
        t: Date.now(),
        mono: monotonicTime(),
        payload: {
          origin,
          schemaHash: hash,
          mode: "schema-only",
          reason
        }
      });
    }
  }
}

function resolveLocalStorageSnapshotMode(
  policy: CapturePolicy | undefined
): LocalStorageSnapshotMode | null {
  if (policy?.categories.storage === "allow" || policy?.categories.storage === "lengths-only") {
    return policy.categories.storage;
  }

  return null;
}

async function captureTraceMetrics(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.cdp !== "full") {
    return;
  }

  const metrics = await sendCdpCommand<Record<string, unknown>>(
    runtime,
    { tabId: runtime.tabId },
    "Performance.getMetrics"
  );

  if (!metrics) {
    return;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(metrics));
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.trace",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      traceHash: hash,
      durationMs: 0,
      mode: "reportEvents",
      categories: "metrics",
      reason
    }
  });
}

async function captureAdvancedProfiles(runtime: SessionRuntime, reason: string): Promise<void> {
  await Promise.allSettled([
    captureCpuProfile(runtime, reason),
    captureHeapSnapshot(runtime, reason)
  ]);
}

async function captureCpuProfile(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  if (runtime.config.capturePolicy?.categories.cdp !== "full") {
    return;
  }

  await sendCdpCommand(runtime, { tabId: runtime.tabId }, "Profiler.enable");

  try {
    const started = await sendCdpCommandOutcome(
      runtime,
      { tabId: runtime.tabId },
      "Profiler.start"
    );

    if (!started.ok) {
      return;
    }

    await wait(CPU_PROFILE_SAMPLE_MS);

    const profileResult = await sendCdpCommand<{ profile?: unknown }>(
      runtime,
      { tabId: runtime.tabId },
      "Profiler.stop"
    );

    if (!profileResult?.profile) {
      return;
    }

    const bytes = new TextEncoder().encode(JSON.stringify(profileResult.profile));
    const hash = await runtime.pipeline.putBlob("application/json", bytes);

    ingestRawEvent({
      source: "system",
      rawType: "cdp.perf.cpu.profile",
      sid: runtime.sid,
      tabId: runtime.tabId,
      t: Date.now(),
      mono: monotonicTime(),
      payload: {
        profileHash: hash,
        sampleMs: CPU_PROFILE_SAMPLE_MS,
        size: bytes.byteLength,
        reason
      }
    });
  } finally {
    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "Profiler.disable");
  }
}

async function captureHeapSnapshot(runtime: SessionRuntime, reason: string): Promise<void> {
  if (!runtime.cdpRouter) {
    return;
  }

  if (
    runtime.config.capturePolicy?.mode !== "lab" ||
    runtime.config.capturePolicy.categories.heapProfiles !== "lab-only"
  ) {
    return;
  }

  runtime.heapSnapshotCapture = {
    chunks: [],
    bytes: 0,
    truncated: false
  };

  await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.enable");

  const completed = await sendCdpCommandOutcome(
    runtime,
    { tabId: runtime.tabId },
    "HeapProfiler.takeHeapSnapshot",
    {
      reportProgress: false,
      captureNumericValue: true
    },
    CDP_HEAP_SNAPSHOT_TIMEOUT_MS
  );

  const snapshot = runtime.heapSnapshotCapture;
  runtime.heapSnapshotCapture = null;

  if (!completed.ok || !snapshot || snapshot.chunks.length === 0) {
    await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
    return;
  }

  const joined = snapshot.chunks.join("");
  const bytes = new TextEncoder().encode(joined);
  const hash = await runtime.pipeline.putBlob("application/json", bytes);

  ingestRawEvent({
    source: "system",
    rawType: "cdp.perf.heap.snapshot",
    sid: runtime.sid,
    tabId: runtime.tabId,
    t: Date.now(),
    mono: monotonicTime(),
    payload: {
      snapshotHash: hash,
      size: bytes.byteLength,
      chunkCount: snapshot.chunks.length,
      truncated: snapshot.truncated,
      reason
    }
  });

  await sendCdpCommand(runtime, { tabId: runtime.tabId }, "HeapProfiler.disable");
}

function shouldCaptureAdvancedProfiles(reason: string): boolean {
  return reason === "manual";
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function sendCdpCommand<TResult = unknown>(
  runtime: SessionRuntime,
  target: { tabId: number; sessionId?: string },
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<TResult | undefined> {
  const outcome = await sendCdpCommandOutcome<TResult>(runtime, target, method, params, timeoutMs);
  return outcome.ok ? outcome.value : undefined;
}

async function sendCdpCommandOutcome<TResult = unknown>(
  runtime: SessionRuntime,
  target: { tabId: number; sessionId?: string },
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CDP_ARTIFACT_TIMEOUT_MS
): Promise<CdpCommandOutcome<TResult>> {
  if (!runtime.cdpRouter || runtime.stopping) {
    return { ok: false, error: "debugger detached" };
  }

  return withCdpCommandTimeout(runtime.cdpRouter.send<TResult>(target, method, params), timeoutMs);
}

async function evaluateExpression(runtime: SessionRuntime, expression: string): Promise<unknown> {
  if (!runtime.cdpRouter) {
    return undefined;
  }

  const result = await sendCdpCommand<{
    result?: {
      value?: unknown;
    };
  }>(runtime, { tabId: runtime.tabId }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  return result?.result?.value;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    return new TextEncoder().encode(value);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function resolveLiteBodyCaptureRule(
  runtime: SessionRuntime,
  url: string,
  mimeType: string | undefined
): LiteBodyCaptureRule {
  return applyBodyUrlFilters(
    resolveLiteBodyCaptureRuleUtil(runtime.config, url, mimeType, {
      defaultMimeAllowlist: resolveProfileBodyMimeAllowlist(
        runtime,
        LITE_DEFAULT_BODY_MIME_ALLOWLIST
      ),
      fallbackMaxBytes: NETWORK_BODY_MAX_BYTES
    }),
    url,
    runtime.profile.selection.profile.network
  );
}

function resolveFullBodyCaptureRule(
  runtime: SessionRuntime,
  url: string,
  mimeType: string | undefined
): LiteBodyCaptureRule {
  return applyBodyUrlFilters(
    resolveFullBodyCaptureRuleUtil(runtime.config, url, mimeType, {
      defaultMimeAllowlist: resolveProfileBodyMimeAllowlist(
        runtime,
        FULL_DEFAULT_BODY_MIME_ALLOWLIST
      ),
      fallbackMaxBytes: NETWORK_BODY_MAX_BYTES
    }),
    url,
    runtime.profile.selection.profile.network
  );
}

/** The profile's body MIME allowlist, or the engine's default when the profile sets none. */
function resolveProfileBodyMimeAllowlist(
  runtime: SessionRuntime,
  engineDefault: readonly string[]
): string[] {
  const profileAllowlist = runtime.profile.selection.profile.network.bodyMimeAllowlist;
  return profileAllowlist.length > 0 ? profileAllowlist : [...engineDefault];
}

function isMimeAllowed(allowlist: string[], mimeType: string | undefined): boolean {
  return isMimeAllowedUtil(allowlist, mimeType);
}

function normalizeMimeType(value: string | null): string | undefined {
  return normalizeMimeTypeUtil(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeContentFrameId(value: unknown): string | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null) {
    return undefined;
  }

  const frameId = Math.max(0, Math.floor(candidate));

  if (frameId <= 0) {
    return undefined;
  }

  return `content-frame-${frameId}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null || candidate <= 0) {
    return undefined;
  }

  return Math.max(1, Math.round(candidate));
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  const candidate = asFiniteNumber(value);

  if (candidate === null || candidate < 0) {
    return undefined;
  }

  return Math.max(0, Math.round(candidate));
}

function encodeTextWithByteLimit(
  value: string,
  maxBytes: number
): { bytes: Uint8Array; truncated: boolean } {
  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(value);

  if (fullBytes.byteLength <= maxBytes) {
    return {
      bytes: fullBytes,
      truncated: false
    };
  }

  const roughRatio = Math.max(0.05, maxBytes / fullBytes.byteLength);
  let targetChars = Math.max(1, Math.floor(value.length * roughRatio));
  let clipped = value.slice(0, targetChars);
  let clippedBytes = encoder.encode(clipped);

  while (clippedBytes.byteLength > maxBytes && targetChars > 1) {
    targetChars = Math.max(1, Math.floor(targetChars * 0.9));
    clipped = value.slice(0, targetChars);
    clippedBytes = encoder.encode(clipped);
  }

  return {
    bytes: clippedBytes,
    truncated: true
  };
}

function normalizeScreenshotViewport(
  value: unknown
): { width: number; height: number; dpr: number } | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const width = normalizePositiveInt(row.width);
  const height = normalizePositiveInt(row.height);
  const dpr = asFiniteNumber(row.dpr);

  if (!width || !height || dpr === null || dpr <= 0) {
    return undefined;
  }

  return {
    width,
    height,
    dpr: Number(dpr.toFixed(3))
  };
}

function normalizeScreenshotPointer(
  value: unknown
): { x: number; y: number; t?: number; mono?: number } | undefined {
  const row = asRecord(value);

  if (!row) {
    return undefined;
  }

  const x = asFiniteNumber(row.x);
  const y = asFiniteNumber(row.y);
  const t = asFiniteNumber(row.t);
  const mono = asFiniteNumber(row.mono);

  if (x === null || y === null) {
    return undefined;
  }

  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    t: t === null ? undefined : t,
    mono: mono === null ? undefined : mono
  };
}

function normalizeSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  return Math.max(250, Math.round(value));
}

function normalizeOptionalSamplingInterval(candidate: unknown, fallback: number): number {
  const value = asFiniteNumber(candidate);

  if (value === null) {
    return fallback;
  }

  if (value <= 0) {
    return 0;
  }

  return Math.max(250, Math.round(value));
}

function resolveExportPolicy(value: unknown): ExportPolicy {
  const row = asRecord(value);
  const includeScreenshots =
    typeof row?.includeScreenshots === "boolean"
      ? row.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;
  const includeScreenRecordings =
    typeof row?.includeScreenRecordings === "boolean"
      ? row.includeScreenRecordings
      : DEFAULT_EXPORT_POLICY.includeScreenRecordings;

  return {
    includeScreenshots,
    includeScreenRecordings,
    maxArchiveBytes: normalizeExportBoundedInt(
      row?.maxArchiveBytes,
      DEFAULT_EXPORT_POLICY.maxArchiveBytes,
      64 * 1024,
      5 * 1024 * 1024 * 1024
    ),
    recentWindowMs: normalizeExportBoundedInt(
      row?.recentWindowMs,
      DEFAULT_EXPORT_POLICY.recentWindowMs,
      1 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000
    )
  };
}

function normalizeExportBoundedInt(
  candidate: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const value = asFiniteNumber(candidate);

  if (value === null || value <= 0) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function toStatusPointer(runtime: SessionRuntime): PointerCaptureOptions {
  return { ...DEFAULT_POINTER_CAPTURE_OPTIONS, ...runtime.config.pointer };
}

function toStatusSampling(runtime: SessionRuntime): RecordingSampling {
  const sampling = runtime.config.sampling;

  return {
    mousemoveHz: Math.max(1, Math.round(asFiniteNumber(sampling.mousemoveHz) ?? 20)),
    scrollHz: Math.max(1, Math.round(asFiniteNumber(sampling.scrollHz) ?? 15)),
    domFlushMs: normalizeSamplingInterval(sampling.domFlushMs, 100),
    snapshotIntervalMs: normalizeSamplingInterval(sampling.snapshotIntervalMs, 20_000),
    screenshotIdleMs: normalizeOptionalSamplingInterval(
      sampling.screenshotIdleMs,
      DEFAULT_RECORDER_CONFIG.sampling.screenshotIdleMs
    ),
    bodyCaptureMaxBytes:
      runtime.config.capturePolicy?.categories.network === "body-allowlist"
        ? normalizeBodyCaptureMaxBytesUtil(sampling.bodyCaptureMaxBytes, 0)
        : 0
  };
}

function buildExportPrivacyWarning(
  scanner: PrivacyScannerResult | undefined
): ExportPrivacyWarning | undefined {
  if (scanner?.status !== "blocked" || scanner.findings.length === 0) {
    return undefined;
  }

  const findings = scanner.findings.slice(0, 8).map((finding) => ({
    kind: finding.kind,
    path: finding.path,
    matchCount: finding.matchCount
  }));
  const summary = findings
    .slice(0, 5)
    .map((finding) => `${finding.kind} in ${finding.path}`)
    .join(", ");

  return {
    findingCount: scanner.findings.length,
    summary,
    findings
  };
}

/**
 * Installs the page hooks in a frame (the top frame by default). On a frame that already has them
 * the script only resets their config to inactive, so callers send the frame its recording
 * status afterwards.
 */
async function ensureInjectedHooks(
  tabId: number,
  bridgeNonce: string,
  frameId?: number
): Promise<void> {
  const target = frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] };

  await chromeApi?.scripting
    ?.executeScript({
      target,
      world: "MAIN",
      files: ["injected.js"]
    })
    .catch(() => undefined);
  // Hand the nonce over as a function argument rather than a DOM event, which page
  // scripts could observe.
  await chromeApi?.scripting
    ?.executeScript({
      target,
      world: "MAIN",
      func: applyInjectedBridgeNonce,
      args: [INJECTED_BRIDGE_NONCE_SETTER_KEY, bridgeNonce]
    })
    .catch(() => undefined);
}

/** Runs in the page MAIN world; must stay self-contained (serialized by Chrome). */
function applyInjectedBridgeNonce(setterKey: string, nonce: string): void {
  const setter = (window as unknown as Record<string, unknown>)[setterKey];

  if (typeof setter === "function") {
    setter(nonce);
  }
}

/**
 * Runs on Start and after navigations of a recorded tab, whatever the injection mode: frames that
 * already run the content script ignore the second copy (see content/script-guard.ts), and tabs
 * opened before the extension was installed or registered get it too.
 */
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  await chromeApi?.scripting
    ?.executeScript({
      target: { tabId, allFrames: true },
      world: "ISOLATED",
      files: ["content.js"]
    })
    .catch(() => undefined);
}

function installLiteWebRequestCapture(): void {
  if (!chromeApi?.webRequest || liteWebRequestCaptureCleanup) {
    return;
  }

  const filter = { urls: ["<all_urls>"] };
  const onBeforeRequest = (details: {
    requestId: string;
    tabId: number;
    frameId?: number;
    method?: string;
    url: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveLiteRuntimeForWebRequest(details.tabId);

    if (!runtime) {
      return;
    }

    const startedAt = normalizeLiteNetworkTimestamp(details.timeStamp);
    upsertRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId), {
      url: details.url,
      method: details.method,
      startedAt
    });

    ingestRawEvent(
      buildLiteNetworkRequestRawEvent(
        {
          sid: runtime.sid,
          tabId: runtime.tabId,
          frame: normalizeContentFrameId(details.frameId)
        },
        {
          requestId: details.requestId,
          method: details.method,
          url: details.url,
          timeStamp: startedAt
        }
      )
    );
  };

  const onCompleted = (details: {
    requestId: string;
    tabId: number;
    frameId?: number;
    method?: string;
    url: string;
    statusCode?: number;
    statusLine?: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveLiteRuntimeForWebRequest(details.tabId);

    if (!runtime) {
      return;
    }

    const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
    const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

    ingestRawEvent(
      buildLiteNetworkResponseRawEvent(
        {
          sid: runtime.sid,
          tabId: runtime.tabId,
          frame: normalizeContentFrameId(details.frameId)
        },
        {
          requestId: details.requestId,
          method: details.method ?? metadata?.method,
          url: details.url ?? metadata?.url ?? "unknown://request",
          statusCode: details.statusCode,
          statusLine: details.statusLine,
          timeStamp: endedAt,
          duration:
            typeof metadata?.startedAt === "number"
              ? Math.max(0, endedAt - metadata.startedAt)
              : undefined
        }
      )
    );

    deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
  };

  const onErrorOccurred = (details: {
    requestId: string;
    tabId: number;
    frameId?: number;
    method?: string;
    url: string;
    error?: string;
    timeStamp?: number;
  }) => {
    const runtime = resolveLiteRuntimeForWebRequest(details.tabId);

    if (!runtime) {
      return;
    }

    const metadata = getRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
    const endedAt = normalizeLiteNetworkTimestamp(details.timeStamp);

    ingestRawEvent(
      buildLiteNetworkFailureRawEvent(
        {
          sid: runtime.sid,
          tabId: runtime.tabId,
          frame: normalizeContentFrameId(details.frameId)
        },
        {
          requestId: details.requestId,
          method: details.method ?? metadata?.method,
          url: details.url ?? metadata?.url ?? "unknown://request",
          timeStamp: endedAt,
          duration:
            typeof metadata?.startedAt === "number"
              ? Math.max(0, endedAt - metadata.startedAt)
              : undefined,
          error: details.error
        }
      )
    );

    deleteRequestMeta(runtime.requestMeta, buildRequestMetaKey(details.requestId));
  };

  chromeApi.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
  chromeApi.webRequest.onCompleted.addListener(onCompleted, filter);
  chromeApi.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);

  liteWebRequestCaptureCleanup = () => {
    chromeApi.webRequest?.onBeforeRequest.removeListener(onBeforeRequest);
    chromeApi.webRequest?.onCompleted.removeListener(onCompleted);
    chromeApi.webRequest?.onErrorOccurred.removeListener(onErrorOccurred);
    liteWebRequestCaptureCleanup = null;
  };
}

function uninstallLiteWebRequestCaptureIfUnused(): void {
  if (!liteWebRequestCaptureCleanup || hasActiveLiteRuntime()) {
    return;
  }

  liteWebRequestCaptureCleanup();
}

function hasActiveLiteRuntime(): boolean {
  for (const runtime of sessionRegistry.tabRuntimes()) {
    if (runtime.mode === "lite" && !runtime.stopping && !runtime.stoppedAt) {
      return true;
    }
  }

  return false;
}

function resolveLiteRuntimeForWebRequest(tabId: number): SessionRuntime | undefined {
  if (!Number.isFinite(tabId) || tabId < 0) {
    return undefined;
  }

  const runtime = sessionRegistry.getByTab(tabId);

  if (!runtime || runtime.mode !== "lite" || runtime.stopping) {
    return undefined;
  }

  return runtime;
}

function normalizeLiteNetworkTimestamp(candidate: unknown): number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? Math.round(candidate)
    : Date.now();
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

function isTrustedOffscreenPort(port: PortLike): boolean {
  return isOffscreenDocumentPort(port, chromeApi?.runtime?.getURL(OFFSCREEN_PATH) ?? "");
}

/** Hands the key to the offscreen document; the port was checked on connect. */
async function sendAtRestKeyToOffscreen(port: PortLike): Promise<void> {
  try {
    offscreenClient.post(port, toStorageKeyMessage(await getAtRestKey()));
  } catch (error) {
    console.warn("[WebBlackbox] failed to send the at-rest key to the offscreen document", error);
  }
}

/** Snapshot of a stopped recording, so a later worker can list, export or expire it. */
async function rememberStoppedSession(runtime: SessionRuntime): Promise<void> {
  if (!runtime.stoppedAt || !sessionRegistry.hasSid(runtime.sid)) {
    return;
  }

  await stoppedSessionStore.remember(toStoppedSessionSnapshot(runtime)).catch((error) => {
    console.warn("[WebBlackbox] failed to keep the stopped recording restorable", error);
  });
}

async function forgetStoppedSession(sid: string): Promise<void> {
  detachedPipelineSids.delete(sid);
  await stoppedSessionStore.forget(sid).catch((error) => {
    console.warn("[WebBlackbox] failed to drop a stopped recording's snapshot", error);
  });
  await clearRetentionAlarm(chromeApi?.alarms, sid).catch(() => undefined);
}

function toStoppedSessionSnapshot(runtime: SessionRuntime): StoppedSessionSnapshot {
  const stoppedAt = runtime.stoppedAt ?? Date.now();

  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
    stoppedAt,
    expiresAt: resolveStoppedSessionExpiresAt(runtime),
    url: runtime.url,
    title: runtime.title,
    profile: {
      request: runtime.profile.request,
      visualCapture: runtime.profile.visualCapture,
      selection: runtime.profile.selection,
      profileConfig: runtime.profile.profileConfig,
      visualsCaptured: runtime.profile.visualsCaptured,
      ...(runtime.profile.cancellation
        ? {
            cancellation: runtime.profile.cancellation,
            cancellationAcknowledged: runtime.profile.cancellationAcknowledged ?? false
          }
        : {})
    },
    config: runtime.config,
    counters: {
      eventCount: runtime.capturedEventCount,
      errorCount: runtime.capturedErrorCount,
      sizeBytes: runtime.capturedSizeBytes,
      budgetAlertCount: runtime.budgetAlertCount
    }
  };
}

/**
 * Rebuilds the stopped recordings an earlier worker of this browser session left: they are listed
 * and exportable again, and those past their retention are deleted. Nothing is restored under a
 * freshly minted key: the database was deleted with the old one.
 */
async function restoreStoppedSessions(): Promise<void> {
  try {
    await getAtRestKey();
  } catch {
    return;
  }

  if (atRestKeyMinted) {
    await stoppedSessionStore.clear().catch(() => undefined);
    return;
  }

  const plan = planStoppedSessionRestore(await stoppedSessionStore.list(), Date.now());

  if (plan.kept.length + plan.purgeNow.length + plan.purgeLater.length === 0) {
    return;
  }

  const performanceBudget = await loadPerformanceBudgetConfig();

  for (const snapshot of plan.kept) {
    scheduleStoppedRuntimeCleanup(restoreStoppedRuntime(snapshot, performanceBudget));
  }

  for (const snapshot of plan.purgeLater) {
    await scheduleRetentionAlarm(
      chromeApi?.alarms,
      snapshot.sid,
      Date.now() + STOPPED_SESSION_PURGE_RETRY_MS
    ).catch(() => undefined);
  }

  // All registered first, so the offscreen document is closed once, after the last purge. The
  // purges run one by one before any message is answered: in parallel they would race offscreen
  // creation, and one finishing late could close the document of a Start that just began.
  const expired = plan.purgeNow.map((snapshot) =>
    restoreStoppedRuntime(snapshot, performanceBudget)
  );

  for (const runtime of expired) {
    await disposeStoppedSession(runtime).catch((error) => {
      console.warn("[WebBlackbox] failed to delete an expired recording", error);
    });
  }

  console.info("[WebBlackbox] restored stopped recordings", {
    kept: plan.kept.length,
    purged: plan.purgeNow.length,
    retrying: plan.purgeLater.length
  });
}

function restoreStoppedRuntime(
  snapshot: StoppedSessionSnapshot,
  performanceBudget: PerformanceBudgetConfig
): SessionRuntime {
  const existing = sessionRegistry.getBySid(snapshot.sid);

  if (existing) {
    return existing;
  }

  const runtime = createSessionRuntime(
    {
      sid: snapshot.sid,
      tabId: snapshot.tabId,
      mode: snapshot.mode,
      profile: snapshot.profile,
      url: snapshot.url,
      title: snapshot.title,
      annotation: getSessionAnnotation(snapshot.sid),
      config: snapshot.config,
      startedAt: snapshot.startedAt,
      stoppedAt: snapshot.stoppedAt,
      pipeline: createSessionPipelineClient(offscreenClient, snapshot.sid),
      recorderPlugins: createDefaultRecorderPlugins(),
      performanceBudget,
      counters: snapshot.counters
    },
    { createFullBodyCapture }
  );

  sessionRegistry.registerBySid(runtime);
  detachedPipelineSids.add(runtime.sid);
  return runtime;
}

/** Gives the offscreen document the pipeline of a stopped recording it does not hold. */
function attachStoppedPipeline(runtime: SessionRuntime): Promise<void> {
  const sid = runtime.sid;

  if (!detachedPipelineSids.has(sid)) {
    return Promise.resolve();
  }

  const pending = pipelineAttachments.get(sid);

  if (pending) {
    return pending;
  }

  const generation = offscreenGeneration;
  const attachment = runtime.pipeline
    .start(toSessionMetadata(runtime), runtime.config.redaction, runtime.config.capturePolicy)
    .then(() => {
      // An offscreen document that went away meanwhile took the pipeline with it.
      if (generation === offscreenGeneration) {
        detachedPipelineSids.delete(sid);
      }
    })
    .finally(() => {
      pipelineAttachments.delete(sid);
    });

  pipelineAttachments.set(sid, attachment);
  return attachment;
}

/** A new offscreen document holds no pipeline of the stopped recordings. */
function markStoppedPipelinesDetached(): void {
  offscreenGeneration += 1;

  for (const runtime of sessionRegistry.sidRuntimes()) {
    if (runtime.stoppedAt) {
      detachedPipelineSids.add(runtime.sid);
    }
  }
}

async function expireStoppedSession(sid: string): Promise<void> {
  await runtimeStateRestored;
  const runtime = sessionRegistry.getBySid(sid) ?? (await restoreStoppedSnapshot(sid));

  if (!runtime) {
    await forgetStoppedSession(sid);
    return;
  }

  if (runtime.stoppedAt) {
    await disposeStoppedSession(runtime);
  }
}

/** Rebuilds a recording whose earlier purge failed, so it can be deleted again. */
async function restoreStoppedSnapshot(sid: string): Promise<SessionRuntime | undefined> {
  const snapshot = (await stoppedSessionStore.list()).find((row) => row.sid === sid);
  return snapshot
    ? restoreStoppedRuntime(snapshot, await loadPerformanceBudgetConfig())
    : undefined;
}

async function retryStoppedSessionPurge(sid: string): Promise<void> {
  const attempts = await stoppedSessionStore.recordPurgeFailure(sid).catch(() => null);

  if (attempts === null || attempts >= MAX_STOPPED_SESSION_PURGE_ATTEMPTS) {
    console.warn("[WebBlackbox] giving up on deleting a recording; it ends with the browser", {
      attempts
    });
    await forgetStoppedSession(sid);
    return;
  }

  detachedPipelineSids.add(sid);
  await scheduleRetentionAlarm(
    chromeApi?.alarms,
    sid,
    Date.now() + STOPPED_SESSION_PURGE_RETRY_MS
  ).catch(() => undefined);
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

async function teardownCaptureInstrumentation(runtime: SessionRuntime): Promise<void> {
  if (runtime.pipelineFlushTimer !== null) {
    clearTimeout(runtime.pipelineFlushTimer);
    runtime.pipelineFlushTimer = null;
  }

  await cleanupCdpInstrumentation(runtime, runtime.cdpRouter);
}

async function cleanupCdpInstrumentation(
  runtime: SessionRuntime,
  router: CdpRouter | null
): Promise<void> {
  if (runtime.screenshotInterval !== null) {
    clearInterval(runtime.screenshotInterval);
    runtime.screenshotInterval = null;
  }

  if (router) {
    await router.detach(runtime.tabId).catch(() => undefined);
  }

  for (const dispose of runtime.removeCdpListeners.splice(0, runtime.removeCdpListeners.length)) {
    dispose();
  }

  router?.dispose();

  if (runtime.cdpRouter === router) {
    runtime.cdpRouter = null;
  }

  runtime.enabledCdpSessions.clear();
  runtime.requestMeta.clear();
  runtime.fullBodyCapture.close();
  runtime.heapSnapshotCapture = null;
}

function scheduleStoppedRuntimeCleanup(runtime: SessionRuntime): void {
  if (runtime.cleanupTimer !== null) {
    clearTimeout(runtime.cleanupTimer);
    runtime.cleanupTimer = null;
  }

  const expiresAt = resolveStoppedSessionExpiresAt(runtime);

  if (chromeApi?.alarms) {
    void scheduleRetentionAlarm(chromeApi.alarms, runtime.sid, expiresAt).catch((error) => {
      console.warn("[WebBlackbox] failed to schedule the recording's retention", error);
    });
    return;
  }

  runtime.cleanupTimer = setTimeout(
    () => {
      void disposeStoppedSession(runtime);
    },
    Math.max(0, expiresAt - Date.now())
  );
}

function resolveStoppedSessionExpiresAt(runtime: SessionRuntime): number {
  return (runtime.stoppedAt ?? Date.now()) + resolveRuntimeStoppedSessionTtlMs(runtime);
}

function resolveRuntimeStoppedSessionTtlMs(runtime: SessionRuntime): number {
  return resolveStoppedSessionTtlMs(
    resolveUnexportedRetentionMs(runtime.profile.selection.profile),
    runtime.config.capturePolicy?.retention.localTtlMs
  );
}

async function rememberStoppedSessionRecord(runtime: SessionRuntime): Promise<void> {
  const record: StoppedSessionRecord = {
    sid: runtime.sid,
    stoppedAt: runtime.stoppedAt ?? Date.now(),
    expiresAt: resolveStoppedSessionExpiresAt(runtime)
  };

  await updateStoppedSessionRecords((records) => upsertStoppedSessionRecord(records, record));
}

async function forgetStoppedSessionRecord(sid: string): Promise<void> {
  await updateStoppedSessionRecords((records) => removeStoppedSessionRecord(records, sid));
}

function updateStoppedSessionRecords(
  update: (records: StoppedSessionRecord[]) => StoppedSessionRecord[]
): Promise<StoppedSessionRecord[]> {
  const task = stoppedSessionRecordsQueue.then(async () => {
    const storage = chromeApi?.storage?.local;

    if (!storage?.get || !storage.set) {
      return [];
    }

    const values = await storage.get(STOPPED_SESSIONS_STORAGE_KEY);
    const next = update(parseStoppedSessionRecords(values?.[STOPPED_SESSIONS_STORAGE_KEY]));
    await storage.set({ [STOPPED_SESSIONS_STORAGE_KEY]: next });
    return next;
  });

  stoppedSessionRecordsQueue = task.catch(() => undefined);
  return task;
}

/**
 * Deletes pipeline data that no live runtime can reach any more: sessions orphaned by
 * a worker restart and stopped sessions past their retention. Runs on worker start,
 * because the per-session cleanup timers die with the previous worker.
 */
async function sweepStalePipelineSessions(): Promise<void> {
  if (!globalThis.indexedDB) {
    return;
  }

  // Identity update: reads the records through the same queue as concurrent writers.
  const records = await updateStoppedSessionRecords((current) => current);
  const now = Date.now();
  const recordsBySid = new Map(records.map((record) => [record.sid, record]));
  const result = await sweepPipelineSessions(
    new IndexedDbPipelineStorage(PIPELINE_DB_NAME),
    (session) =>
      shouldSweepStoredSession({
        session,
        liveSids: new Set(sessionRegistry.bySid.keys()),
        records: recordsBySid,
        now,
        bootedAt: SERVICE_WORKER_BOOTED_AT
      })
  );
  const deletedSids = new Set(result.deleted);

  await updateStoppedSessionRecords((current) =>
    pruneStoppedSessionRecords(current, now, deletedSids)
  );

  if (result.deleted.length > 0 || result.failed.length > 0) {
    console.info("[WebBlackbox] swept stale pipeline sessions", {
      deleted: result.deleted.length,
      failed: result.failed
    });
  }
}

async function disposeStoppedSession(runtime: SessionRuntime): Promise<void> {
  if (!sessionRegistry.hasSid(runtime.sid) || disposingSids.has(runtime.sid)) {
    return;
  }

  disposingSids.add(runtime.sid);

  try {
    await purgeStoppedSession(runtime);
  } finally {
    disposingSids.delete(runtime.sid);
  }
}

async function purgeStoppedSession(runtime: SessionRuntime): Promise<void> {
  if (runtime.cleanupTimer !== null) {
    clearTimeout(runtime.cleanupTimer);
    runtime.cleanupTimer = null;
  }

  await attachStoppedPipeline(runtime).catch((error) => {
    console.warn("[WebBlackbox] cannot reach a restored recording to delete it", error);
  });
  await flushBufferedPipelineEvents(runtime);
  await runtime.queue;
  await runtime.pipeline.flush().catch(() => undefined);
  const purged = await runtime.pipeline.close({ purge: true }).then(
    () => true,
    (error: unknown) => {
      console.warn("[WebBlackbox] failed to delete a stopped recording; retrying later", error);
      return false;
    }
  );
  sessionRegistry.unregisterSid(runtime.sid);
  await forgetStoppedSessionRecord(runtime.sid).catch((error) => {
    console.warn("[WebBlackbox] failed to drop stopped session record", error);
  });

  if (purged) {
    await forgetStoppedSession(runtime.sid);
  } else {
    // The snapshot stays, so the retry (or the next worker start) can rebuild and delete it.
    await retryStoppedSessionPurge(runtime.sid);
  }

  await refreshActionBadge();

  await closeOffscreenIfUnused();
  pushSessionList();
  await persistRuntimeState();
  notifyOffscreenPipelineStatus();
}

async function closeOffscreenIfUnused(): Promise<void> {
  if (sessionRegistry.sidCount() > 0) {
    return;
  }

  await chromeApi?.offscreen?.closeDocument?.().catch(() => undefined);
}

async function downloadExportedBundle(
  exported: PipelineExportDownloadResult,
  saveAs: boolean
): Promise<void> {
  if (!chromeApi?.downloads?.download) {
    throw new Error("Downloads API is unavailable in service worker context.");
  }

  const downloadId = await chromeApi.downloads.download({
    url: exported.downloadUrl,
    filename: `webblackbox/${exported.fileName}`,
    saveAs
  });

  exported.downloadId = downloadId;
}

function toSessionListItem(runtime: SessionRuntime): SessionListItem {
  const activeRuntime = sessionRegistry.getByTab(runtime.tabId);
  const active = activeRuntime?.sid === runtime.sid;

  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt,
    active,
    stoppedAt: runtime.stoppedAt,
    url: sanitizeUrlForPrivacy(runtime.url),
    title: runtime.title,
    eventCount: runtime.capturedEventCount,
    errorCount: runtime.capturedErrorCount,
    budgetAlertCount: runtime.budgetAlertCount,
    sizeBytes: runtime.capturedSizeBytes,
    tags: [...runtime.tags],
    note: runtime.note,
    profileName: runtime.profile.selection.profile.name,
    ...(runtime.profile.cancellation && !runtime.profile.cancellationAcknowledged
      ? { profileCancel: toProfileCancelNotice(runtime.profile.cancellation) }
      : {})
  };
}

function toSessionMetadata(runtime: SessionRuntime): SessionMetadata {
  return {
    sid: runtime.sid,
    tabId: runtime.tabId,
    startedAt: runtime.startedAt,
    mode: runtime.mode,
    url: sanitizeUrlForPrivacy(runtime.url),
    title: runtime.title,
    tags: [...runtime.tags]
  };
}

async function resolveTabSessionMetadata(
  tabId: number
): Promise<Pick<SessionMetadata, "url" | "title">> {
  const fallbackUrl = `tab:${tabId}`;

  if (!chromeApi?.tabs?.get) {
    return {
      url: fallbackUrl
    };
  }

  try {
    const tab = await chromeApi.tabs.get(tabId);
    const url =
      typeof tab?.url === "string" && tab.url.length > 0
        ? sanitizeUrlForPrivacy(tab.url)
        : fallbackUrl;
    const title =
      typeof tab?.title === "string" && tab.title.trim().length > 0 ? tab.title.trim() : undefined;

    return {
      url,
      title
    };
  } catch {
    return {
      url: fallbackUrl
    };
  }
}

function updateSessionMetadataFromEvent(runtime: SessionRuntime, event: WebBlackboxEvent): void {
  void updateSessionMetadataFromEventAsync(runtime, event).catch((error) => {
    console.warn("[WebBlackbox] failed to update session navigation metadata", error);
  });
}

async function updateSessionMetadataFromEventAsync(
  runtime: SessionRuntime,
  event: WebBlackboxEvent
): Promise<void> {
  if (
    event.type !== "nav.commit" &&
    event.type !== "nav.history.push" &&
    event.type !== "nav.history.replace" &&
    event.type !== "nav.hash"
  ) {
    return;
  }

  const payload = asRecord(event.data);

  if (!shouldUpdateSessionMetadataFromNavigation(event, payload)) {
    return;
  }

  const frame = asRecord(payload?.frame);
  const nextUrl = asString(payload?.url) ?? asString(frame?.url);
  const nextTitle = asString(payload?.title) ?? asString(payload?.documentTitle);
  let changed = false;

  const sanitizedNextUrl = nextUrl ? sanitizeUrlForPrivacy(nextUrl) : undefined;

  if (sanitizedNextUrl && sanitizedNextUrl !== runtime.url) {
    const nextOrigin = resolveUrlOrigin(sanitizedNextUrl);

    if (shouldStopOnOriginChange(runtime, nextOrigin)) {
      await stopSession(runtime.tabId);
      return;
    }

    if (await shouldStopForEnterpriseOriginPolicy(nextOrigin)) {
      await stopSession(runtime.tabId);
      return;
    }

    runtime.url = sanitizedNextUrl;
    changed = true;
  }

  if (nextTitle && nextTitle.trim().length > 0 && nextTitle !== runtime.title) {
    runtime.title = nextTitle.trim();
    changed = true;
  }

  if (changed) {
    pushSessionList();
  }
}

function pushSessionList(): void {
  sessionListPush.now();
}

function buildSessionListMessage(): SessionListMessage {
  const sessions: SessionListItem[] = [...sessionRegistry.sidRuntimes()]
    .map((runtime) => toSessionListItem(runtime))
    .sort((left, right) => {
      const activeDiff = Number(right.active) - Number(left.active);

      if (activeDiff !== 0) {
        return activeDiff;
      }

      return right.startedAt - left.startedAt;
    });

  return {
    kind: "sw.session-list",
    sessions
  };
}

async function handleTabUrlChanged(tabId: number, rawUrl: string): Promise<void> {
  const runtime = sessionRegistry.getByTab(tabId);

  if (!runtime || runtime.stoppedAt) {
    return;
  }

  const nextUrl = sanitizeUrlForPrivacy(rawUrl);
  const nextOrigin = resolveUrlOrigin(nextUrl);

  if (shouldStopOnOriginChange(runtime, nextOrigin)) {
    await stopSession(tabId);
    return;
  }

  if (await shouldStopForEnterpriseOriginPolicy(nextOrigin)) {
    await stopSession(tabId);
    return;
  }

  if (nextUrl !== runtime.url) {
    runtime.url = nextUrl;
    pushSessionList();
  }

  // Relations to other tabs are computed against the recorded tab's origin.
  void tabsContextTracker?.updateSession(tabId, { url: rawUrl });
  rememberVisitedPageUrl(runtime, rawUrl);

  scheduleProfileReevaluation(runtime, "navigation");
}

function shouldStopOnOriginChange(runtime: SessionRuntime, nextOrigin: string | null): boolean {
  return shouldStopForCaptureScopeOriginChange({
    scopeOrigin: runtime.scopeOrigin,
    nextOrigin,
    stopOnOriginChange: runtime.config.capturePolicy?.scope.stopOnOriginChange === true,
    activeTabScopedBuild: isActiveTabScopedBuild()
  });
}

async function shouldStopForEnterpriseOriginPolicy(nextOrigin: string | null): Promise<boolean> {
  const enterprisePolicy = await loadEnterprisePolicy();

  return shouldStopForEnterpriseOriginPolicyInput({
    nextOrigin,
    isEnterpriseOriginAllowed: (origin) => isEnterpriseOriginAllowed(origin, enterprisePolicy)
  });
}

function isActiveTabScopedBuild(): boolean {
  const manifest = chromeApi?.runtime?.getManifest?.();
  const permissions = new Set(manifest?.permissions ?? []);
  const hostPermissions = manifest?.host_permissions ?? [];

  return permissions.has("activeTab") && hostPermissions.length === 0;
}

function broadcast(message: ExtensionOutboundMessage): void {
  for (const port of connectedPorts) {
    if (isBroadcastDeliveredToPort(message.kind, port.name)) {
      sendPortMessage(port, message);
    }
  }
}

function sendPortMessage(port: PortLike, message: ExtensionOutboundMessage): void {
  try {
    if (port === offscreenPort) {
      offscreenPortTraffic.recordSent(message.kind, message);
    }

    port.postMessage(message);
  } catch (error) {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
    }

    logPortSendFailure(message.kind, error, {
      portName: port.name
    });
  }
}

function resolveFullModeVisualCapture(
  message: ExtensionInboundMessage
): FullModeVisualCapture | undefined {
  if (message.kind !== "ui.start") {
    return undefined;
  }

  // Kept for a Lite request too: when the profile needs the Full engine the start runs in Full,
  // and an explicit choice (e.g. "none") must hold there. A Lite session ignores it.
  return isFullModeVisualCapture(message.visualCapture) ? message.visualCapture : undefined;
}

function isFullModeVisualCapture(value: unknown): value is FullModeVisualCapture {
  return value === "screenshots" || value === "recording" || value === "both" || value === "none";
}

async function loadEnterprisePolicy(): Promise<EnterpriseRecorderPolicy> {
  return normalizeEnterprisePolicy((await readEnterprisePolicy()) ?? {});
}

function withSessionCapturePolicy(
  config: typeof DEFAULT_RECORDER_CONFIG,
  context: {
    tabId: number;
    origin: string;
    startedAt: number;
  }
): typeof DEFAULT_RECORDER_CONFIG {
  const basePolicy =
    config.capturePolicy ?? DEFAULT_RECORDER_CONFIG.capturePolicy ?? DEFAULT_CAPTURE_POLICY;
  const capturePolicy: CapturePolicy = {
    ...basePolicy,
    consent: {
      ...basePolicy.consent,
      grantedAt: new Date(context.startedAt).toISOString()
    },
    scope: {
      ...basePolicy.scope,
      tabId: context.tabId,
      origin: context.origin,
      allowedOrigins: [...basePolicy.scope.allowedOrigins],
      stopOnOriginChange: false
    },
    redaction: config.redaction
  };

  return {
    ...config,
    capturePolicy
  };
}

async function loadPerformanceBudgetConfig(): Promise<PerformanceBudgetConfig> {
  await settingsMigrated;
  const storedValues = await chromeApi?.storage?.local?.get(PERFORMANCE_BUDGET_STORAGE_KEY);
  return normalizePerformanceBudget(storedValues?.[PERFORMANCE_BUDGET_STORAGE_KEY]);
}

async function updateSessionAnnotation(
  sid: string,
  tagsInput: unknown,
  noteInput: unknown
): Promise<void> {
  const tags = normalizeSessionTags(tagsInput);
  const note = normalizeSessionNote(noteInput);
  const runtime = sessionRegistry.getBySid(sid);

  if (runtime) {
    runtime.tags = [...tags];
    runtime.note = note;
  }

  sessionAnnotations.set(sid, {
    tags: [...tags],
    note
  });

  await persistSessionAnnotations().catch(() => undefined);
  pushSessionList();
}

function getSessionAnnotation(sid: string): SessionAnnotation {
  const annotation = sessionAnnotations.get(sid);

  if (!annotation) {
    return {
      tags: []
    };
  }

  return {
    tags: [...annotation.tags],
    note: annotation.note
  };
}

/**
 * Tags and notes describe recordings that do not survive a browser restart, so they live in the
 * in-memory `storage.session` area too; a copy left on disk by older builds is removed.
 */
async function loadSessionAnnotations(): Promise<void> {
  sessionAnnotations.clear();
  await chromeApi?.storage?.local?.remove?.(SESSION_ANNOTATIONS_STORAGE_KEY).catch(() => undefined);

  const area = chromeApi?.storage?.session;

  if (!area) {
    return;
  }

  const values = await area.get(SESSION_ANNOTATIONS_STORAGE_KEY).catch(() => undefined);
  const raw = asRecord(values?.[SESSION_ANNOTATIONS_STORAGE_KEY]);

  if (!raw) {
    return;
  }

  for (const [sid, payload] of Object.entries(raw)) {
    const row = asRecord(payload);
    const tags = normalizeSessionTags(row?.tags);
    const note = normalizeSessionNote(row?.note);

    sessionAnnotations.set(sid, {
      tags,
      note
    });
  }
}

async function persistSessionAnnotations(): Promise<void> {
  const area = chromeApi?.storage?.session;

  if (!area) {
    return;
  }

  const serialized: Record<string, SessionAnnotation> = {};

  for (const [sid, annotation] of sessionAnnotations.entries()) {
    serialized[sid] = {
      tags: [...annotation.tags],
      note: annotation.note
    };
  }

  await area.set({
    [SESSION_ANNOTATIONS_STORAGE_KEY]: serialized
  });
}

function normalizeSessionTags(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const raw of input) {
    if (typeof raw !== "string") {
      continue;
    }

    const normalized = raw.trim().slice(0, 40);

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);

    if (tags.length >= 12) {
      break;
    }
  }

  return tags;
}

function normalizeSessionNote(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const normalized = input.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 500);
}

async function persistRuntimeState(): Promise<void> {
  if (!chromeApi?.storage?.local?.set) {
    return;
  }

  const sessions = [...sessionRegistry.tabRuntimes()].map((runtime) => ({
    sid: runtime.sid,
    tabId: runtime.tabId,
    mode: runtime.mode,
    startedAt: runtime.startedAt
  }));

  await chromeApi.storage.local.set({
    [ACTIVE_SESSION_STORAGE_KEY]: sessions
  });
}

async function appendExportAuditEvent(event: ExportAuditEvent): Promise<void> {
  if (!chromeApi?.storage?.local?.get || !chromeApi.storage.local.set) {
    return;
  }

  const values = await chromeApi.storage.local.get(EXPORT_AUDIT_STORAGE_KEY);
  const current = Array.isArray(values[EXPORT_AUDIT_STORAGE_KEY])
    ? (values[EXPORT_AUDIT_STORAGE_KEY] as unknown[])
    : [];
  const events = [...current.slice(-EXPORT_AUDIT_MAX_EVENTS + 1), event];

  await chromeApi.storage.local.set({
    [EXPORT_AUDIT_STORAGE_KEY]: events
  });
}

function redactOperationalMessage(message: string): string {
  return message
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted-token]")
    .replaceAll(/\b(?:https?|file):\/\/[^\s)]+/gi, "[redacted-url]")
    .slice(0, 240);
}

async function restoreRuntimeState(): Promise<void> {
  await loadSessionAnnotations();

  if (!chromeApi?.storage?.local?.get) {
    return;
  }

  const values = await chromeApi.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
  const persisted = values?.[ACTIVE_SESSION_STORAGE_KEY];

  if (Array.isArray(persisted) && persisted.length > 0) {
    await chromeApi.storage.local
      .set({
        [ACTIVE_SESSION_STORAGE_KEY]: []
      })
      .catch(() => undefined);

    for (const item of persisted) {
      const row = asRecord(item);
      const tabId = typeof row?.tabId === "number" ? row.tabId : undefined;

      if (typeof tabId === "number") {
        await notifyTabStatus(tabId, false);
      }
    }
  }

  await restoreStoppedSessions();
  await setIdleBadge();
  pushSessionList();
  notifyOffscreenPipelineStatus();
  await sweepStalePipelineSessions().catch((error) => {
    console.warn("[WebBlackbox] failed to sweep stale pipeline sessions", error);
  });
}

function notifyOffscreenPipelineStatus(): void {
  const port = offscreenPort;

  if (!port) {
    return;
  }

  try {
    const message: SwPipelineStatusMessage = {
      kind: "sw.pipeline-status",
      activeSessions: sessionRegistry.tabCount(),
      sessions: [...sessionRegistry.tabRuntimes()].map((runtime) => ({
        sid: runtime.sid,
        tabId: runtime.tabId,
        mode: runtime.mode,
        startedAt: runtime.startedAt,
        active: true,
        eventCount: runtime.capturedEventCount,
        errorCount: runtime.capturedErrorCount,
        budgetAlertCount: runtime.budgetAlertCount,
        sizeBytes: runtime.capturedSizeBytes,
        tags: [...runtime.tags],
        note: runtime.note
      })),
      updatedAt: Date.now()
    };
    offscreenClient.post(port, message);
  } catch (error) {
    connectedPorts.delete(port);

    if (offscreenPort === port) {
      offscreenPort = null;
    }

    logPortSendFailure("sw.pipeline-status", error, {
      activeSessions: sessionRegistry.tabCount()
    });
  }
}

async function notifyTabStatus(
  tabId: number,
  active: boolean,
  sid?: string,
  mode?: CaptureMode,
  sampling?: RecordingSampling,
  capturePolicy?: CapturePolicy,
  injectedBridgeNonce?: string,
  pointer?: PointerCaptureOptions
): Promise<void> {
  if (!chromeApi?.tabs?.sendMessage) {
    return;
  }

  const runtime = active ? sessionRegistry.getByTab(tabId) : undefined;

  await chromeApi.tabs
    .sendMessage(tabId, {
      kind: "sw.recording-status",
      active,
      sid,
      mode,
      sampling,
      capturePolicy,
      injectedBridgeNonce,
      pointer,
      ...(runtime ? toScriptScanStatus(runtime) : {})
    })
    .catch(() => undefined);
}

function adjustInFlightContentMessages(tabId: number, delta: 1 | -1): void {
  const next = (inFlightContentMessagesByTab.get(tabId) ?? 0) + delta;

  if (next <= 0) {
    inFlightContentMessagesByTab.delete(tabId);
    resolveStopDrainAcksForTab(tabId);
    return;
  }

  inFlightContentMessagesByTab.set(tabId, next);
}

function createStopDrainAck(runtime: SessionRuntime): Promise<void> {
  const existing = pendingStopDrainAcks.get(runtime.sid);

  if (existing) {
    clearTimeout(existing.timeout);
    pendingStopDrainAcks.delete(runtime.sid);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingStopDrainAcks.delete(runtime.sid);
      resolve();
    }, STOP_DRAIN_ACK_TIMEOUT_MS);

    pendingStopDrainAcks.set(runtime.sid, {
      sid: runtime.sid,
      tabId: runtime.tabId,
      ackReceived: false,
      resolve,
      timeout
    });
  });
}

function markStopDrainAckReceived(sid: string): void {
  const pending = pendingStopDrainAcks.get(sid);

  if (!pending) {
    return;
  }

  pending.ackReceived = true;
  resolveStopDrainAckIfReady(pending);
}

function resolveStopDrainAcksForTab(tabId: number): void {
  for (const pending of pendingStopDrainAcks.values()) {
    if (pending.tabId === tabId) {
      resolveStopDrainAckIfReady(pending);
    }
  }
}

function resolveStopDrainAckIfReady(pending: {
  sid: string;
  tabId: number;
  ackReceived: boolean;
  resolve: () => void;
  timeout: ReturnType<typeof setTimeout>;
}): void {
  if (!pending.ackReceived) {
    return;
  }

  if ((inFlightContentMessagesByTab.get(pending.tabId) ?? 0) > 0) {
    return;
  }

  pendingStopDrainAcks.delete(pending.sid);
  clearTimeout(pending.timeout);

  const runtime = sessionRegistry.getBySid(pending.sid);

  if (!runtime) {
    pending.resolve();
    return;
  }

  void runtime.queue.finally(() => {
    pending.resolve();
  });
}

async function relayMarkerCommand(): Promise<void> {
  const activeTabs = (await chromeApi?.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
  const tabId = activeTabs[0]?.id;

  if (typeof tabId !== "number") {
    return;
  }

  await chromeApi?.tabs?.sendMessage(tabId, { kind: "sw.marker-command" }).catch(() => undefined);
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

function parseInboundMessage(message: unknown): ExtensionInboundMessage | null {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const kind = (message as { kind?: unknown }).kind;

  if (typeof kind !== "string") {
    return null;
  }

  return message as ExtensionInboundMessage;
}

async function setIdleBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "" }).catch(() => undefined);
}

async function setRecordingBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "REC" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#c92a2a" }).catch(() => undefined);
}

async function setFreezeBadge(): Promise<void> {
  await chromeApi?.action?.setBadgeText({ text: "ERR" }).catch(() => undefined);
  await chromeApi?.action?.setBadgeBackgroundColor({ color: "#9b2226" }).catch(() => undefined);

  if (freezeBadgeTimer !== null) {
    clearTimeout(freezeBadgeTimer);
  }

  freezeBadgeTimer = setTimeout(() => {
    freezeBadgeTimer = null;

    if (sessionRegistry.tabCount() > 0) {
      void setRecordingBadge();
      return;
    }

    void setIdleBadge();
  }, FREEZE_BADGE_HIGHLIGHT_MS);
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

function logPortSendFailure(
  kind: string,
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  if (!shouldLogPortDebug()) {
    return;
  }

  console.debug("[WebBlackbox][port] service worker postMessage failed", {
    kind,
    ...context,
    error: error instanceof Error ? error.message : String(error)
  });
}

function logInboundMessageFailure(
  kind: string,
  error: unknown,
  port?: PortLike,
  context: Record<string, unknown> = {}
): void {
  console.warn("[WebBlackbox] inbound message failed", {
    kind,
    port: port?.name,
    tabId: context.tabId ?? port?.sender?.tab?.id,
    frameId: context.frameId ?? port?.sender?.frameId,
    error: error instanceof Error ? error.message : String(error)
  });
}
