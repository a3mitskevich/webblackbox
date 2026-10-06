import {
  createSessionId,
  sanitizeUrlForPrivacy,
  type CaptureMode,
  type CapturePolicy,
  type FreezeReason,
  type PointerCaptureOptions,
  type SessionMetadata,
  type WebBlackboxEvent
} from "@webblackbox/protocol";
import {
  createDefaultRecorderPlugins,
  WebBlackboxRecorder,
  type RawRecorderEvent
} from "@webblackbox/recorder";

import type { ChromeApi } from "../shared/chrome-api.js";
import type { ExtensionOutboundMessage, FullModeVisualCapture } from "../shared/messages.js";
import {
  applyEnterprisePolicyToRecorderConfig,
  getSessionStartBlockReason
} from "../shared/options-storage.js";
import type { PerformanceBudgetConfig } from "../shared/performance-budget.js";
import { resolveStartEngine } from "../shared/profiles/engine.js";
import {
  AUTO_PROFILE_ID,
  buildProfileRecorderConfig,
  listEnterpriseCappedCategories,
  toArchivedProfileInfo
} from "../shared/profiles/resolve.js";
import type { AtRestKeyRecord } from "./at-rest-key.js";
import type { ScreenRecordingController } from "./artifacts-screen-recording.js";
import type { StorageArtifactsController } from "./artifacts-storage.js";
import {
  applyBodyUrlFilters,
  DEFAULT_BODY_CAPTURE_MAX_BYTES,
  DEFAULT_BODY_MIME_ALLOWLIST,
  isInlineRequestBodyAllowed,
  resolveFullBodyCaptureRule as resolveFullBodyCaptureRuleUtil,
  type BodyCaptureRule
} from "./body-capture-utils.js";
import type { FullCdpController } from "./full-cdp.js";
import { toScriptScanStatus } from "./full-cdp.js";
import type { LiteNetworkBaselineController } from "./lite-network.js";
import { resolveLiteBodyCaptureRule, resolveProfileBodyMimeAllowlist } from "./lite-materialize.js";
import type { SessionPipelineClient } from "./offscreen-client.js";
import { extractPerformanceBudgetNetworkSample } from "./performance-budget.js";
import type { PipelineBuffer } from "./pipeline-buffer.js";
import {
  withSessionCapturePolicy,
  type ProfileReevaluationController
} from "./profile-reevaluation.js";
import { capturedVisualsOf, NO_RECORDING_PROFILE_ERROR } from "./profile-runtime.js";
import type { RecordedTabWatch } from "./recorded-tab-watch.js";
import {
  ensureContentScriptInjected,
  ensureInjectedHooks,
  toStatusPointer,
  toStatusSampling,
  type RecordingSampling,
  type ScriptingApiLike
} from "./recording-status.js";
import type { SessionAnnotationsController } from "./session-annotations.js";
import {
  createSessionRuntime,
  resolveUrlOrigin,
  type SessionRegistry,
  type SessionRuntime
} from "./session-registry.js";
import type { StopDrainTracker } from "./stop-drain.js";
import type { StoppedSessionLifecycleController } from "./stopped-session-lifecycle.js";
import { resolveTabsContextLevel, type TabsContextTracker } from "./tabs-context/tracker.js";

/**
 * How long stop waits for response bodies still being read before recording them as skipped:
 * a base plus a share per pending body, capped.
 */
const FULL_MODE_BODY_STOP_DRAIN_MS = 3_000;
const FULL_MODE_BODY_STOP_DRAIN_PER_BODY_MS = 25;
const FULL_MODE_BODY_STOP_DRAIN_MAX_MS = 15_000;
const FREEZE_BADGE_HIGHLIGHT_MS = 15_000;
const PERFORMANCE_BUDGET_BREACH_COOLDOWN_MS = 15_000;
const PERFORMANCE_BUDGET_ERROR_RATE_MIN_SAMPLES = 10;
/** Full mode reads bodies through CDP whatever loaded them, so SVG images (text) are kept too. */
const FULL_DEFAULT_BODY_MIME_ALLOWLIST = [...DEFAULT_BODY_MIME_ALLOWLIST, "image/svg+xml"];
const ACTIVE_SESSION_STORAGE_KEY = "webblackbox.runtime.sessions";

export type SessionCommandsTabsApi = Pick<
  NonNullable<ChromeApi["tabs"]>,
  "get" | "reload" | "sendMessage"
>;
export type SessionCommandsActionApi = NonNullable<ChromeApi["action"]>;
export type SessionCommandsStorageLocal = NonNullable<ChromeApi["storage"]>["local"];

export type SessionCommandsDeps = {
  sessionRegistry: SessionRegistry;
  annotations: SessionAnnotationsController;
  stopDrain: StopDrainTracker;
  pipelineBuffer: PipelineBuffer;
  profile: ProfileReevaluationController;
  fullCdp: Pick<
    FullCdpController,
    "attachCdp" | "createFullBodyCapture" | "cleanupCdpInstrumentation"
  >;
  screenRecording: Pick<
    ScreenRecordingController,
    "shouldStartScreenRecording" | "startScreenRecording" | "stopScreenRecording"
  >;
  storageArtifacts: Pick<StorageArtifactsController, "captureCookieValues">;
  liteNetworkBaseline: LiteNetworkBaselineController;
  recordedTabWatch: RecordedTabWatch;
  tabsContextTracker: TabsContextTracker | null;
  stoppedSessionLifecycle: StoppedSessionLifecycleController;
  tabs: SessionCommandsTabsApi | undefined;
  scripting: ScriptingApiLike | undefined;
  action: SessionCommandsActionApi | undefined;
  storageLocal: SessionCommandsStorageLocal | undefined;
  broadcast: (message: ExtensionOutboundMessage) => void;
  notifyOffscreenPipelineStatus: () => void;
  pushSessionList: () => void;
  scheduleSessionListPush: () => void;
  ingestRawEvent: (rawEvent: RawRecorderEvent) => void;
  enqueueWithResult: <TResult>(
    runtime: SessionRuntime,
    task: () => Promise<TResult>
  ) => Promise<TResult>;
  updateSessionMetadataFromEvent: (runtime: SessionRuntime, event: WebBlackboxEvent) => void;
  handleFreezeNotice: (runtime: SessionRuntime, reason: FreezeReason) => void;
  getAtRestKey: () => Promise<AtRestKeyRecord>;
  ensureOffscreenDocument: () => Promise<void>;
  createPipeline: (sid: string) => SessionPipelineClient;
  loadPerformanceBudgetConfig: () => Promise<PerformanceBudgetConfig>;
  monotonicTime: () => number;
};

export type SessionCommandsController = {
  /** Starts recording the tab; resolves with the engine it runs in. */
  startSession: (
    tabId: number,
    requestedMode: CaptureMode,
    options?: { visualCapture?: FullModeVisualCapture; profileId?: string }
  ) => Promise<CaptureMode>;
  stopSession: (tabId: number) => Promise<void>;
  reloadRecordingTab: (tabId: number) => Promise<void>;
  deleteSessionBySid: (sid: string) => Promise<void>;
  acknowledgeProfileCancel: (sid: string) => Promise<void>;
  setIdleBadge: () => Promise<void>;
  setRecordingBadge: () => Promise<void>;
  setFreezeBadge: () => Promise<void>;
  /** REC while anything records, otherwise `!` while a profile-change notice is unread. */
  refreshActionBadge: () => Promise<void>;
  notifyTabStatus: (
    tabId: number,
    active: boolean,
    sid?: string,
    mode?: CaptureMode,
    sampling?: RecordingSampling,
    capturePolicy?: CapturePolicy,
    injectedBridgeNonce?: string,
    pointer?: PointerCaptureOptions
  ) => Promise<void>;
  resolveFullBodyCaptureRule: (
    runtime: SessionRuntime,
    url: string,
    mimeType: string | undefined
  ) => BodyCaptureRule;
  persistRuntimeState: () => Promise<void>;
  restoreRuntimeState: () => Promise<void>;
};

/**
 * The session commands the inbound router dispatches to: Start, Stop, Delete and the profile
 * cancel acknowledgement, plus the badge and the runtime-state persistence those commands drive.
 */
export function createSessionCommands(deps: SessionCommandsDeps): SessionCommandsController {
  const { sessionRegistry } = deps;
  let freezeBadgeTimer: ReturnType<typeof setTimeout> | null = null;

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
    await deps.getAtRestKey();
    await deps.ensureOffscreenDocument();

    const sid = createSessionId();
    const startedAt = Date.now();
    const tabMetadata = await resolveTabSessionMetadata(tabId);
    const sessionOrigin = resolveUrlOrigin(sanitizeUrlForPrivacy(tabMetadata.url)) ?? "";
    const enterprisePolicy = await deps.profile.loadEnterprisePolicy();

    const startBlockReason = getSessionStartBlockReason(sessionOrigin, enterprisePolicy);

    if (startBlockReason) {
      throw new Error(startBlockReason);
    }

    const profileRequest = options.profileId ?? AUTO_PROFILE_ID;
    const profileSelection = await deps.profile.resolveTabProfileSelection(tabId, profileRequest);

    if (!profileSelection) {
      throw new Error(NO_RECORDING_PROFILE_ERROR);
    }

    // A profile that needs the Full engine never runs in Lite, whatever the caller asked for:
    // Lite would drop its bodies, socket messages and visuals without a trace. Upgrading (rather
    // than refusing) keeps the start the user asked for; the popup already shows the engine as
    // Full.
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
    const performanceBudget = await deps.loadPerformanceBudgetConfig();
    const annotation = deps.annotations.get(sid);
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
    const pipeline = deps.createPipeline(sid);
    await pipeline.start(metadata, recorderConfig.redaction, recorderConfig.capturePolicy);

    const runtime = createSessionRuntime(
      {
        sid,
        tabId,
        mode,
        profile: {
          request: profileRequest,
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
      { createFullBodyCapture: deps.fullCdp.createFullBodyCapture }
    );

    runtime.recorder = new WebBlackboxRecorder(
      {
        ...recorderConfig,
        mode
      },
      {
        onEvent: (event) => {
          deps.updateSessionMetadataFromEvent(runtime, event);
          trackSessionCounters(runtime, event);
          evaluatePerformanceBudget(runtime, event);
          deps.pipelineBuffer.enqueuePipelineEvent(runtime, event);
        },
        onFreeze: (reason) => {
          deps.handleFreezeNotice(runtime, reason);
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
    deps.recordedTabWatch.sync(true);

    if (mode === "lite") {
      deps.liteNetworkBaseline.install();
    }

    deps.ingestRawEvent({
      source: "system",
      rawType: "config",
      sid,
      tabId,
      t: Date.now(),
      mono: deps.monotonicTime(),
      payload: {
        ...recorderConfig,
        profile: toArchivedProfileInfo(
          profileSelection,
          listEnterpriseCappedCategories(loadedRecorderConfig, recorderConfig)
        )
      }
    });

    // Other tabs of the site right after the config, before instrumentation can take a while.
    await deps.tabsContextTracker?.startSession(tabId, {
      url: tabMetadata.url,
      level: resolveTabsContextLevel(recorderConfig.capturePolicy)
    });

    await ensureContentScriptInjected(deps.scripting, tabId);
    await ensureInjectedHooks(deps.scripting, tabId, runtime.injectedBridgeNonce);

    if (mode === "full" && recorderConfig.capturePolicy?.categories.cdp !== "off") {
      await deps.fullCdp.attachCdp(runtime);
    }

    if (deps.screenRecording.shouldStartScreenRecording(runtime)) {
      try {
        await deps.screenRecording.startScreenRecording(runtime);
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
    deps.broadcast({
      kind: "sw.recording-status",
      active: true,
      sid,
      mode,
      sampling,
      capturePolicy: recorderConfig.capturePolicy,
      pointer,
      ...toScriptScanStatus(runtime)
    });
    deps.pushSessionList();
    await persistRuntimeState();
    deps.notifyOffscreenPipelineStatus();
    return mode;
  }

  async function stopSession(tabId: number): Promise<void> {
    const runtime = sessionRegistry.getByTab(tabId);

    if (!runtime || runtime.stopping) {
      return;
    }

    runtime.stopping = true;
    // Changes of other tabs seen before Stop still belong to the session.
    await deps.tabsContextTracker?.settle();
    deps.tabsContextTracker?.stopSession(tabId);
    const stopDrainAck = deps.stopDrain.createStopDrainAck(runtime);
    await deps.screenRecording.stopScreenRecording(runtime, "session-stop").catch((error) => {
      console.warn("[WebBlackbox] failed to stop screen recording", error);
    });

    if (runtime.mode === "full" && runtime.config.capturePolicy?.categories.cookies === "allow") {
      await deps.storageArtifacts.captureCookieValues(runtime, "session-stop").catch((error) => {
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
    await deps.pipelineBuffer.flushBufferedPipelineEvents(runtime);
    await teardownCaptureInstrumentation(runtime);
    sessionRegistry.unregisterTab(runtime.tabId);
    deps.recordedTabWatch.sync(sessionRegistry.tabCount() > 0);
    deps.liteNetworkBaseline.uninstallIfUnused();
    runtime.stoppedAt = Date.now();
    deps.stoppedSessionLifecycle.scheduleStoppedRuntimeCleanup(runtime);
    await deps.stoppedSessionLifecycle.rememberStoppedSessionRecord(runtime).catch((error) => {
      console.warn("[WebBlackbox] failed to persist stopped session record", error);
    });
    // Written now and again after the final flush: the worker may die while the page drains.
    await deps.stoppedSessionLifecycle.rememberStoppedSession(runtime);

    await refreshActionBadge();

    await notifyTabStatus(
      tabId,
      false,
      runtime.sid,
      runtime.mode,
      toStatusSampling(runtime),
      runtime.config.capturePolicy
    );
    deps.broadcast({
      kind: "sw.recording-status",
      active: false,
      sid: runtime.sid,
      mode: runtime.mode,
      capturePolicy: runtime.config.capturePolicy
    });
    deps.pushSessionList();
    await persistRuntimeState();
    deps.notifyOffscreenPipelineStatus();
    await stopDrainAck;
    await deps.pipelineBuffer.flushBufferedPipelineEvents(runtime);
    runtime.stopDrained = true;
    // The recording now waits for its export, possibly in a later worker: its tail goes to the
    // encrypted store and a snapshot lets that worker list and export it.
    await deps
      .enqueueWithResult(runtime, () => runtime.pipeline.flush())
      .catch((error) => {
        console.warn("[WebBlackbox] failed to flush the stopped recording", error);
      });
    await deps.stoppedSessionLifecycle.rememberStoppedSession(runtime);
  }

  async function reloadRecordingTab(tabId: number): Promise<void> {
    if (!deps.tabs?.reload) {
      throw new Error("Current Chrome API cannot reload the active tab.");
    }

    await deps.tabs.reload(tabId);
  }

  async function deleteSessionBySid(sid: string): Promise<void> {
    const runtime = sessionRegistry.getBySid(sid);

    if (!runtime) {
      await deps.annotations.remove(sid);
      return;
    }

    if (!runtime.stoppedAt) {
      await stopSession(runtime.tabId);
    }

    await deps.stoppedSessionLifecycle.disposeStoppedSession(runtime);

    if (await deps.annotations.remove(sid)) {
      deps.pushSessionList();
    }
  }

  async function acknowledgeProfileCancel(sid: string): Promise<void> {
    const runtime = sessionRegistry.getBySid(sid);

    if (!runtime?.profile.cancellation || runtime.profile.cancellationAcknowledged) {
      return;
    }

    runtime.profile = { ...runtime.profile, cancellationAcknowledged: true };
    deps.pushSessionList();
    await refreshActionBadge();
    // A later worker restores the acknowledged notice, not the unread one.
    await deps.stoppedSessionLifecycle.rememberStoppedSession(runtime);
  }

  async function setIdleBadge(): Promise<void> {
    await deps.action?.setBadgeText({ text: "" }).catch((error) => {
      console.warn("[WebBlackbox] failed to clear the action badge", error);
    });
  }

  async function setRecordingBadge(): Promise<void> {
    await deps.action?.setBadgeText({ text: "REC" }).catch((error) => {
      console.warn("[WebBlackbox] failed to set the recording badge", error);
    });
    await deps.action?.setBadgeBackgroundColor({ color: "#c92a2a" }).catch((error) => {
      console.warn("[WebBlackbox] failed to set the recording badge color", error);
    });
  }

  async function setFreezeBadge(): Promise<void> {
    await deps.action?.setBadgeText({ text: "ERR" }).catch((error) => {
      console.warn("[WebBlackbox] failed to set the freeze badge", error);
    });
    await deps.action?.setBadgeBackgroundColor({ color: "#9b2226" }).catch((error) => {
      console.warn("[WebBlackbox] failed to set the freeze badge color", error);
    });

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

    await deps.action?.setBadgeText({ text: "!" }).catch((error) => {
      console.warn("[WebBlackbox] failed to set the profile-change badge", error);
    });
    await deps.action?.setBadgeBackgroundColor({ color: "#b35c00" }).catch((error) => {
      console.warn("[WebBlackbox] failed to set the profile-change badge color", error);
    });
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
    if (!deps.tabs?.sendMessage) {
      return;
    }

    const runtime = active ? sessionRegistry.getByTab(tabId) : undefined;

    await deps.tabs
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
      .catch((error) => {
        console.warn("[WebBlackbox] failed to send the tab its recording status", {
          tabId,
          active,
          error
        });
      });
  }

  async function resolveTabSessionMetadata(
    tabId: number
  ): Promise<Pick<SessionMetadata, "url" | "title">> {
    const fallbackUrl = `tab:${tabId}`;

    if (!deps.tabs?.get) {
      return {
        url: fallbackUrl
      };
    }

    try {
      const tab = await deps.tabs.get(tabId);
      const url =
        typeof tab?.url === "string" && tab.url.length > 0
          ? sanitizeUrlForPrivacy(tab.url)
          : fallbackUrl;
      const title =
        typeof tab?.title === "string" && tab.title.trim().length > 0
          ? tab.title.trim()
          : undefined;

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

  function trackSessionCounters(runtime: SessionRuntime, event: WebBlackboxEvent): void {
    runtime.capturedEventCount += 1;

    if (event.type === "error.exception" || event.type === "error.unhandledrejection") {
      runtime.capturedErrorCount += 1;
      deps.scheduleSessionListPush();
      return;
    }

    if (runtime.capturedEventCount % 50 === 0) {
      deps.scheduleSessionListPush();
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
      deps.scheduleSessionListPush();
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
      deps.handleFreezeNotice(runtime, "perf");
    }

    return true;
  }

  async function teardownCaptureInstrumentation(runtime: SessionRuntime): Promise<void> {
    if (runtime.pipelineFlushTimer !== null) {
      clearTimeout(runtime.pipelineFlushTimer);
      runtime.pipelineFlushTimer = null;
    }

    await deps.fullCdp.cleanupCdpInstrumentation(runtime, runtime.cdpRouter);
  }

  function resolveFullBodyCaptureRule(
    runtime: SessionRuntime,
    url: string,
    mimeType: string | undefined
  ): BodyCaptureRule {
    return applyBodyUrlFilters(
      resolveFullBodyCaptureRuleUtil(runtime.config, url, mimeType, {
        defaultMimeAllowlist: resolveProfileBodyMimeAllowlist(
          runtime,
          FULL_DEFAULT_BODY_MIME_ALLOWLIST
        ),
        fallbackMaxBytes: DEFAULT_BODY_CAPTURE_MAX_BYTES
      }),
      url,
      runtime.profile.selection.profile.network
    );
  }

  async function persistRuntimeState(): Promise<void> {
    if (!deps.storageLocal?.set) {
      return;
    }

    const sessions = [...sessionRegistry.tabRuntimes()].map((runtime) => ({
      sid: runtime.sid,
      tabId: runtime.tabId,
      mode: runtime.mode,
      startedAt: runtime.startedAt
    }));

    await deps.storageLocal.set({
      [ACTIVE_SESSION_STORAGE_KEY]: sessions
    });
  }

  async function restoreRuntimeState(): Promise<void> {
    await deps.annotations.load();

    if (deps.storageLocal?.get) {
      const values = await deps.storageLocal.get(ACTIVE_SESSION_STORAGE_KEY);
      const persisted = values?.[ACTIVE_SESSION_STORAGE_KEY];

      if (Array.isArray(persisted) && persisted.length > 0) {
        await deps.storageLocal
          .set({
            [ACTIVE_SESSION_STORAGE_KEY]: []
          })
          .catch((error) => {
            console.warn("[WebBlackbox] failed to clear the persisted runtime state", error);
          });

        for (const item of persisted) {
          const row = asRecord(item);
          const tabId = typeof row?.tabId === "number" ? row.tabId : undefined;

          if (typeof tabId === "number") {
            await notifyTabStatus(tabId, false);
          }
        }
      }
    }

    await deps.stoppedSessionLifecycle.restoreStoppedSessions();
    await setIdleBadge();
    deps.pushSessionList();
    deps.notifyOffscreenPipelineStatus();
    await deps.stoppedSessionLifecycle.sweepStalePipelineSessions().catch((error) => {
      console.warn("[WebBlackbox] failed to sweep stale pipeline sessions", error);
    });
  }

  return {
    startSession,
    stopSession,
    reloadRecordingTab,
    deleteSessionBySid,
    acknowledgeProfileCancel,
    setIdleBadge,
    setRecordingBadge,
    setFreezeBadge,
    refreshActionBadge,
    notifyTabStatus,
    resolveFullBodyCaptureRule,
    persistRuntimeState,
    restoreRuntimeState
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
