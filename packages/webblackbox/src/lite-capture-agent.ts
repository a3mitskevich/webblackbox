import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_POINTER_CAPTURE_OPTIONS,
  type CapturePolicy,
  type PointerCaptureOptions
} from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { LiteCaptureAgentOptions, LiteCaptureSampling, LiteCaptureState } from "./types.js";
import {
  DEFAULT_SAMPLING,
  monotonicTime,
  resolveContentFrameContext,
  sanitizePointerOptions,
  sanitizeSamplingConfig
} from "./lite-capture-config.js";
import {
  capturesPageStorageInFullMode,
  capturesRawDom,
  shouldPageCapture
} from "./capture-scope.js";
import {
  SCRIPT_SOURCE_MAP_RAW_TYPE,
  startScriptSourceMapScanner
} from "./script-source-map-scanner.js";
import { watchPasswordFieldReveals } from "./input-value-policy.js";
import { PointerCaptureController } from "./pointer-capture.js";
import {
  accumulateMutationRecord,
  buildPressureRecoverySnapshotPayload,
  buildRawDomSnapshotPayload,
  buildRrwebMutationPayload,
  buildSummaryDomSnapshotPayload,
  createEmptyMutationSummary,
  OBSERVED_MUTATION_ATTRIBUTES,
  type DomSnapshotSummaryMode,
  type MutationBatchSummary
} from "./lite-dom-snapshot.js";
import {
  EVENT_BUFFER_FORCE_FLUSH_SIZE,
  EVENT_BUFFER_HARD_LIMIT,
  EVENT_BUFFER_SOFT_LIMIT,
  LiteEventBuffer
} from "./lite-event-buffer.js";
import { installInjectedBridgeListener } from "./lite-injected-bridge.js";
import { LiteInputCapture } from "./lite-input-capture.js";
import {
  installPerformanceObservers,
  LONG_TASK_PRESSURE_THRESHOLD_MS,
  RAF_PRESSURE_GAP_MS
} from "./lite-performance-capture.js";
import {
  buildCookieSnapshotPayload,
  buildLocalStorageSnapshotPayload,
  captureIndexedDbSnapshot
} from "./lite-storage-snapshots.js";
import { captureViewportScreenshot } from "./lite-screenshots.js";
import { isEditableInteractionTarget, isRichTextEditableTarget } from "./lite-keystrokes.js";
import { LiteTargetPayloads } from "./lite-target-payload.js";

const SCREENSHOT_POINTER_STALE_MS = 2_500;
const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const BACKGROUND_CAPTURE_IDLE_MS = 1_500;
const START_CAPTURE_STORAGE_DELAY_MS = 400;
const START_CAPTURE_SCREENSHOT_DELAY_MS = 1_000;
const SCROLL_PRESSURE_WINDOW_MS = 700;
const SCROLL_PRESSURE_EVENT_COUNT = 6;
const MUTATION_PRESSURE_RECORD_LIMIT = 220;
const MUTATION_PRESSURE_BUFFER_LIMIT = 280;
const MUTATION_PRESSURE_SUMMARY_LIMIT = 320;
const MUTATION_PRESSURE_SAMPLE_LIMIT = 80;
const MUTATION_PRESSURE_COOLDOWN_MS = 2_500;
const MUTATION_PRESSURE_FLUSH_MS = 300;
const INPUT_PRESSURE_BURST_WINDOW_MS = 900;
const INPUT_PRESSURE_BURST_COUNT = 6;
const INPUT_PRESSURE_COOLDOWN_MS = 1_800;
const INPUT_PRESSURE_EDITOR_COOLDOWN_MS = 2_400;
const INPUT_PRESSURE_MUTATION_SAMPLE_LIMIT = 16;
const QUIET_MODE_MUTATION_RECORD_LIMIT = 360;
const QUIET_MODE_EVENT_BUFFER_LIMIT = 560;
const QUIET_MODE_COOLDOWN_MS = 3_000;
/** Shortest gap between raw DOM snapshots taken because the page changed (`dom: allow`). */
const DOM_CHANGE_SNAPSHOT_INTERVAL_MS = 2_500;
const QUIET_MODE_SCROLL_COOLDOWN_MS = 2_000;
const QUIET_MODE_EDITOR_COOLDOWN_MS = 4_200;
const DOM_SNAPSHOT_SUMMARY_NODE_THRESHOLD = 3_500;
const START_CAPTURE_DEFER_MS = 2_000;
const LONG_TASK_PRESSURE_COOLDOWN_MS = 1_800;
const LONG_TASK_PRESSURE_EXTENDED_COOLDOWN_MS = 3_000;
const RAF_PRESSURE_COOLDOWN_MS = 1_400;
const MUTATION_DETAIL_RECORD_LIMIT = 160;
const MUTATION_DETAIL_BUFFER_LIMIT = 240;

type CapturePressureStage = "none" | "soft" | "hard" | "critical";

/**
 * Browser-side event capture agent used by `WebBlackboxLiteSdk`.
 * It collects DOM/input/network/error/perf signals and emits buffered raw events.
 */
export class LiteCaptureAgent {
  private readonly cleanupCallbacks: Array<() => void> = [];
  private readonly frameMarker: string | undefined;
  private readonly isTopLevelFrame: boolean;

  private recordingActive = false;
  private captureInstalled = false;
  private sid = "";
  private tabId = -1;
  private mode: LiteCaptureState["mode"] = "lite";
  private sampling: LiteCaptureSampling = { ...DEFAULT_SAMPLING };
  private capturePolicy: CapturePolicy = DEFAULT_CAPTURE_POLICY;
  private pointerOptions: PointerCaptureOptions = { ...DEFAULT_POINTER_CAPTURE_OPTIONS };
  private readonly eventBuffer = new LiteEventBuffer({
    emitBatch: (events) => this.options.emitBatch(events),
    mode: () => this.mode
  });
  private readonly targets = new LiteTargetPayloads({
    policy: () => this.capturePolicy,
    mode: () => this.mode,
    isActive: () => this.recordingActive && !this.disposed
  });
  private readonly pointerCapture = new PointerCaptureController({
    options: () => this.pointerOptions,
    policy: () => this.capturePolicy,
    isRecording: () => this.recordingActive && !this.disposed,
    emit: (rawType, payload, mono) => this.queueEvent(rawType, payload, mono),
    targetPayload: (target, detail) => this.targets.createPointerTargetPayload(target, detail),
    listen: (target, type, listener, options) => this.listen(target, type, listener, options),
    markUserActivity: () => this.markUserActivity(),
    trackPointer: (x, y) => this.trackPointer(x, y),
    now: monotonicTime
  });
  private readonly inputCapture = new LiteInputCapture({
    pointerCapture: this.pointerCapture,
    targets: this.targets,
    mode: () => this.mode,
    sampling: () => this.sampling,
    capturePolicy: () => this.capturePolicy,
    listen: (target, type, listener, options) => this.listen(target, type, listener, options),
    emit: (rawType, payload, mono) => this.queueEvent(rawType, payload, mono),
    markUserActivity: () => this.markUserActivity(),
    trackPointer: (x, y) => this.trackPointer(x, y),
    recordEditableInteraction: (target) => this.recordEditableInteraction(target),
    recordScrollPressure: () => this.recordScrollPressure(),
    shouldSuppressPointerMoveCapture: () => this.shouldSuppressPointerMoveCapture(),
    emitMarker: (message) => this.emitMarker(message),
    emitViewportSnapshot: (reason) => this.emitViewportSnapshot(reason),
    emitLifecycleEvent: (rawType, payload) => this.emitLifecycleEvent(rawType, payload)
  });
  private injectedBridgeNonce: string | null = null;
  private indicator: HTMLDivElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private snapshotTimer = 0;
  private screenshotTimer = 0;
  private startCaptureTimer = 0;
  private backgroundCaptureRetryTimer = 0;
  private quietModeRecoveryTimer = 0;
  private deferredStartTaskTimers: number[] = [];
  private mutationFlushTimer = 0;

  private domChangeSnapshotTimer = 0;

  private indexedDbSnapshotInFlight = false;

  private lastDomSnapshotMono = Number.NEGATIVE_INFINITY;
  private screenshotInFlight = false;
  private screenshotCaptureBlocked = false;
  private screenshotInFlightPromise: Promise<void> | null = null;
  private screenshotPendingReason: string | null = null;
  private hasCapturedScreenshot = false;
  private lastActionScreenshotMono = Number.NEGATIVE_INFINITY;
  private lastUserActivityMono = monotonicTime();
  private mutationPressureUntilMono = Number.NEGATIVE_INFINITY;
  private inputPressureUntilMono = Number.NEGATIVE_INFINITY;
  private editorPressureUntilMono = Number.NEGATIVE_INFINITY;
  private quietModeUntilMono = Number.NEGATIVE_INFINITY;
  private longTaskPressureUntilMono = Number.NEGATIVE_INFINITY;
  private rafPressureUntilMono = Number.NEGATIVE_INFINITY;
  private recentEditableInteractionMonos: number[] = [];
  private recentScrollMonos: number[] = [];
  private lastPointerState: { x: number; y: number; t: number; mono: number } | null = null;
  private hasDomSnapshot = false;
  private hasLocalStorageSnapshot = false;
  private mutationSummary: MutationBatchSummary = createEmptyMutationSummary();
  private disposed = false;
  private readonly stopWatchingPasswordReveals: () => void;
  private pendingQuietRecoverySummary = false;
  private stopScriptSourceMapScanner: (() => void) | null = null;

  /** Creates and installs capture hooks for the current page context. */
  public constructor(private readonly options: LiteCaptureAgentOptions) {
    const frameContext = resolveContentFrameContext(options.frameScope);
    this.frameMarker = frameContext.marker;
    this.isTopLevelFrame = frameContext.isTopLevel;
    // Runs while idle too: a password revealed before Start must stay a password.
    this.stopWatchingPasswordReveals =
      typeof document === "undefined" ? () => undefined : watchPasswordFieldReveals(document);
  }

  /** Updates recording state and sampling profile from the host SDK. */
  public setRecordingStatus(state: LiteCaptureState): void {
    if (this.disposed) {
      return;
    }

    const wasRecording = this.recordingActive;

    if (state.active && !wasRecording) {
      this.hasDomSnapshot = false;
      this.hasLocalStorageSnapshot = false;
      this.hasCapturedScreenshot = false;
    }

    if (!state.active && wasRecording && this.shouldCaptureDomSnapshots() && !this.hasDomSnapshot) {
      this.emitDomSnapshot("stop");
    }

    if (
      !state.active &&
      wasRecording &&
      this.shouldCaptureStorageSnapshots() &&
      !this.hasLocalStorageSnapshot
    ) {
      this.emitLocalStorageSnapshot("stop");
    }

    if (!state.active && wasRecording) {
      this.pointerCapture.flushPending();
    }

    this.recordingActive = state.active;
    this.mode = state.mode ?? this.mode;
    this.sampling = sanitizeSamplingConfig(state.sampling);
    this.capturePolicy = state.capturePolicy ?? this.capturePolicy;
    this.syncScriptSourceMapScanner(
      state.active && state.scriptSourceMaps === true && this.mode === "lite"
    );
    this.pointerOptions = sanitizePointerOptions(state.pointer);

    if (typeof state.sid === "string") {
      this.sid = state.sid;
    }

    if (typeof state.injectedBridgeNonce === "string" && state.injectedBridgeNonce.length > 0) {
      this.injectedBridgeNonce = state.injectedBridgeNonce;
    }

    if (typeof state.tabId === "number" && Number.isFinite(state.tabId)) {
      this.tabId = Math.round(state.tabId);
    }

    if (this.recordingActive) {
      this.ensureCaptureInstalled();

      if (!wasRecording) {
        this.eventBuffer.flushPreRecordingBuffer();
      }

      this.ensureIndicator(this.sid, this.mode);
      this.startMutationAndSnapshots();
      return;
    }

    this.stopMutationAndSnapshots();
    this.teardownCapture();
    this.removeIndicator();
    this.flush();
  }

  /** Emits a manual marker event and optional snapshot/screenshot side effects. */
  public emitMarker(message: string): void {
    if (this.disposed) {
      return;
    }

    this.options.onMarker?.(message);
    this.queueEvent("marker", {
      message
    });

    if (this.shouldCaptureDomSnapshots()) {
      this.emitDomSnapshot("marker");
    }

    if (this.shouldCaptureStorageSnapshots()) {
      this.emitStorageSnapshots("marker");
    }

    if (this.shouldCaptureScreenshots()) {
      this.scheduleScreenshotCapture("marker", true);
    }
  }

  /** Forces indicator rendering state regardless of capture state. */
  public setIndicatorState(sid?: string, mode?: string): void {
    if (this.disposed) {
      return;
    }

    this.ensureIndicator(sid, mode);
  }

  /** Flushes the current buffered raw events immediately. */
  public flush(): void {
    this.inputCapture.flushPendingScrollEvent();
    this.eventBuffer.drainBufferedEvents();
  }

  /** Completes any in-flight screenshot and captures one final frame if none was recorded yet. */
  public async prepareStopCapture(): Promise<void> {
    if (this.disposed || !this.recordingActive) {
      return;
    }

    try {
      await this.screenshotInFlightPromise;
    } catch {
      void 0;
    }

    if (this.shouldCaptureScreenshots() && !this.hasCapturedScreenshot) {
      if (this.screenshotCaptureBlocked) {
        return;
      }

      await this.startScreenshotCapture("stop");
    }
  }

  /** Tears down listeners/timers and releases all internal buffers. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.syncScriptSourceMapScanner(false);
    this.stopWatchingPasswordReveals();
    this.stopMutationAndSnapshots();
    this.removeIndicator();

    this.eventBuffer.cancelScheduledFlush();
    this.runCleanupCallbacks();
    this.targets.clearPendingTargetEnrichmentTimers();
    this.pointerCapture.reset();

    this.eventBuffer.clear();
    this.mutationSummary = createEmptyMutationSummary();
    this.targets.resetSelectorCache();
    this.hasCapturedScreenshot = false;
  }

  private installPerformanceCapture(): void {
    installPerformanceObservers({
      mode: () => this.mode,
      emit: (rawType, payload) => this.queueEvent(rawType, payload),
      onLongTask: (duration) => this.extendLongTaskPressure(duration),
      onFrameGap: (frameGap) => this.extendRafPressure(frameGap),
      addCleanup: (cleanup) => {
        this.cleanupCallbacks.push(cleanup);
      }
    });
  }

  private accumulateMutationRecords(records: MutationRecord[]): void {
    if (records.length === 0) {
      return;
    }

    const shouldEnterPressure =
      records.length >= MUTATION_PRESSURE_RECORD_LIMIT ||
      this.eventBuffer.length >= MUTATION_PRESSURE_BUFFER_LIMIT ||
      this.mutationSummary.count >= MUTATION_PRESSURE_SUMMARY_LIMIT;

    if (shouldEnterPressure) {
      this.extendMutationPressureWindow();
    }

    const inputPressureActive = this.isInputPressureActive();
    const pressureActive = this.isMutationPressureActive() || inputPressureActive;
    const includeDetails =
      !pressureActive &&
      records.length <= MUTATION_DETAIL_RECORD_LIMIT &&
      this.eventBuffer.length <= MUTATION_DETAIL_BUFFER_LIMIT;
    const sampleLimit = inputPressureActive
      ? INPUT_PRESSURE_MUTATION_SAMPLE_LIMIT
      : pressureActive
        ? MUTATION_PRESSURE_SAMPLE_LIMIT
        : records.length;
    const sampledCount = Math.min(records.length, sampleLimit);

    const readSelector = (target: EventTarget | null) => this.targets.readCachedSelector(target);

    for (let index = 0; index < sampledCount; index += 1) {
      accumulateMutationRecord(this.mutationSummary, records[index]!, includeDetails, readSelector);
    }

    if (sampledCount < records.length) {
      this.mutationSummary.count += records.length - sampledCount;
      this.mutationSummary.truncated = true;
    }
  }

  private shouldCaptureScreenshots(): boolean {
    return (
      this.mode !== "full" &&
      this.isTopLevelFrame &&
      this.sampling.screenshotIdleMs > 0 &&
      this.capturePolicy.categories.screenshots !== "off"
    );
  }

  /** Full mode leaves DOM changes to CDP unless the profile records the raw DOM. */
  private shouldCaptureMutationSignals(): boolean {
    return (
      (this.mode !== "full" || capturesRawDom(this.capturePolicy.categories)) &&
      this.isTopLevelFrame &&
      this.capturePolicy.categories.dom !== "off"
    );
  }

  /** Full mode leaves the DOM to CDP unless the profile records the raw DOM. */
  private shouldCaptureDomSnapshots(): boolean {
    return (
      (this.mode !== "full" || capturesRawDom(this.capturePolicy.categories)) &&
      this.isTopLevelFrame &&
      this.capturePolicy.categories.dom !== "off"
    );
  }

  private shouldCaptureStorageSnapshots(): boolean {
    return (
      (this.mode !== "full" || capturesPageStorageInFullMode(this.capturePolicy.categories)) &&
      this.isTopLevelFrame &&
      (this.capturePolicy.categories.storage !== "off" ||
        this.capturePolicy.categories.indexedDb !== "off" ||
        this.capturePolicy.categories.cookies !== "off")
    );
  }

  private startMutationAndSnapshots(): void {
    if (this.shouldCaptureMutationSignals() && !this.mutationObserver) {
      this.ensureMutationObserverActive();
    }

    if (
      this.snapshotTimer === 0 &&
      (this.shouldCaptureDomSnapshots() || this.shouldCaptureStorageSnapshots())
    ) {
      const snapshotIntervalMs = Math.max(500, Math.round(this.sampling.snapshotIntervalMs));
      this.snapshotTimer = window.setInterval(() => {
        if (this.shouldDeferBackgroundCapture()) {
          return;
        }

        if (this.shouldCaptureDomSnapshots()) {
          this.emitDomSnapshot("interval");
        }

        if (this.shouldCaptureStorageSnapshots()) {
          this.emitStorageSnapshots("interval");
        }
      }, snapshotIntervalMs);
    }

    if (this.screenshotTimer === 0 && this.shouldCaptureScreenshots()) {
      const screenshotIntervalMs = Math.max(250, Math.round(this.sampling.screenshotIdleMs));
      this.screenshotTimer = window.setInterval(() => {
        this.scheduleScreenshotCapture("interval");
      }, screenshotIntervalMs);
    }

    this.emitViewportSnapshot("start");
    this.scheduleDeferredStartCapture();
  }

  private stopMutationAndSnapshots(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.pendingQuietRecoverySummary = false;
    this.quietModeUntilMono = Number.NEGATIVE_INFINITY;
    this.editorPressureUntilMono = Number.NEGATIVE_INFINITY;
    this.inputPressureUntilMono = Number.NEGATIVE_INFINITY;
    this.recentEditableInteractionMonos = [];
    this.recentScrollMonos = [];

    if (this.snapshotTimer > 0) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = 0;
    }

    if (this.screenshotTimer > 0) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = 0;
    }

    if (this.startCaptureTimer > 0) {
      clearTimeout(this.startCaptureTimer);
      this.startCaptureTimer = 0;
    }

    this.inputCapture.cancelTrailingScrollFlush();

    if (this.backgroundCaptureRetryTimer > 0) {
      clearTimeout(this.backgroundCaptureRetryTimer);
      this.backgroundCaptureRetryTimer = 0;
    }

    if (this.quietModeRecoveryTimer > 0) {
      clearTimeout(this.quietModeRecoveryTimer);
      this.quietModeRecoveryTimer = 0;
    }

    for (const timerId of this.deferredStartTaskTimers.splice(
      0,
      this.deferredStartTaskTimers.length
    )) {
      clearTimeout(timerId);
    }

    this.screenshotPendingReason = null;

    if (this.mutationFlushTimer > 0) {
      clearTimeout(this.mutationFlushTimer);
      this.mutationFlushTimer = 0;
    }

    if (this.mutationSummary.count > 0) {
      this.flushMutationBuffer();
    }

    if (this.domChangeSnapshotTimer > 0) {
      clearTimeout(this.domChangeSnapshotTimer);
      this.domChangeSnapshotTimer = 0;
    }

    this.inputCapture.flushPendingScrollEvent();
  }

  private ensureCaptureInstalled(): void {
    if (this.captureInstalled) {
      return;
    }

    this.inputCapture.install();

    if (this.isTopLevelFrame) {
      this.installPerformanceCapture();
    }

    installInjectedBridgeListener({
      listen: (target, type, listener, options) => this.listen(target, type, listener, options),
      nonce: () => this.injectedBridgeNonce,
      queueRawEvent: (event) => this.queueRawEvent(event),
      emitMarker: (message) => this.emitMarker(message),
      tabId: () => this.tabId,
      sid: () => this.sid
    });
    this.captureInstalled = true;
    this.emitLifecycleEvent("visibilitychange", { state: document.visibilityState });
  }

  /** Lite sessions whose profile asks for it report each script's source map reference. */
  private syncScriptSourceMapScanner(enabled: boolean): void {
    if (enabled && !this.stopScriptSourceMapScanner) {
      this.stopScriptSourceMapScanner = startScriptSourceMapScanner({
        emit: (reference) => this.queueEvent(SCRIPT_SOURCE_MAP_RAW_TYPE, reference)
      });
      return;
    }

    if (!enabled && this.stopScriptSourceMapScanner) {
      this.stopScriptSourceMapScanner();
      this.stopScriptSourceMapScanner = null;
    }
  }

  private teardownCapture(): void {
    if (!this.captureInstalled) {
      return;
    }

    this.captureInstalled = false;
    this.runCleanupCallbacks();
    this.targets.clearPendingTargetEnrichmentTimers();
    this.pointerCapture.reset();
  }

  private runCleanupCallbacks(): void {
    for (const cleanup of this.cleanupCallbacks.splice(0, this.cleanupCallbacks.length)) {
      cleanup();
    }
  }

  private scheduleMutationFlush(): void {
    if (this.mutationFlushTimer > 0) {
      return;
    }

    const flushDelayMs = this.resolveMutationFlushDelay();

    this.mutationFlushTimer = window.setTimeout(() => {
      this.mutationFlushTimer = 0;

      if (this.shouldHoldMutationFlush()) {
        this.scheduleMutationFlush();
        return;
      }

      this.flushMutationBuffer();
    }, flushDelayMs);
  }

  /**
   * Sessions that record the raw DOM snapshot the page again after it changes, at most every
   * {@link DOM_CHANGE_SNAPSHOT_INTERVAL_MS}, so a replayed DOM follows the session instead of
   * freezing at the start snapshot. Under capture pressure the snapshot waits (checked again
   * every interval) and is taken once the pressure ends.
   */
  private scheduleDomChangeSnapshot(): void {
    if (
      this.domChangeSnapshotTimer > 0 ||
      !this.recordingActive ||
      !capturesRawDom(this.capturePolicy.categories) ||
      !this.shouldCaptureDomSnapshots()
    ) {
      return;
    }

    const delayMs = Math.max(
      0,
      this.lastDomSnapshotMono + DOM_CHANGE_SNAPSHOT_INTERVAL_MS - monotonicTime()
    );

    this.domChangeSnapshotTimer = window.setTimeout(() => {
      this.domChangeSnapshotTimer = 0;

      if (!this.recordingActive) {
        return;
      }

      if (this.shouldDeferBackgroundCapture()) {
        // Retried one interval later (the last snapshot time is unchanged).
        this.lastDomSnapshotMono = monotonicTime();
        this.scheduleDomChangeSnapshot();
        return;
      }

      this.emitDomSnapshot("mutation");
    }, delayMs);
  }

  private flushMutationBuffer(): void {
    if (this.mutationSummary.count === 0) {
      return;
    }

    const summary = this.mutationSummary;
    this.mutationSummary = createEmptyMutationSummary();

    this.queueEvent("mutation", {
      count: summary.count,
      summary
    });
    this.emitRrwebMutationSummary(summary);
    this.scheduleDomChangeSnapshot();
  }

  private emitRrwebMutationSummary(summary: MutationBatchSummary): void {
    this.queueEvent("rrweb", buildRrwebMutationPayload(summary, this.capturePolicy.redaction));
  }

  private emitDomSnapshot(reason: string): void {
    this.lastDomSnapshotMono = monotonicTime();
    const nodeCount = document.getElementsByTagName("*").length;
    const summaryMode = this.resolveDomSnapshotSummaryMode(nodeCount);

    if (summaryMode !== "pressure" && this.emitRawDomSnapshot(reason, nodeCount)) {
      return;
    }

    const payload = buildSummaryDomSnapshotPayload({
      reason,
      nodeCount,
      summaryMode,
      redaction: this.capturePolicy.redaction
    });

    this.hasDomSnapshot = true;
    this.queueEvent("snapshot", payload);
  }

  /** `dom: allow`: the page itself, masked by blocked selectors. False when not recorded. */
  private emitRawDomSnapshot(reason: string, nodeCount: number): boolean {
    const payload = buildRawDomSnapshotPayload(reason, nodeCount, this.capturePolicy);

    if (!payload) {
      return false;
    }

    this.hasDomSnapshot = true;
    this.queueEvent("snapshot", payload);
    return true;
  }

  private emitStorageSnapshots(reason: string): void {
    const cookies = this.capturePolicy.categories.cookies;

    // Full mode reads cookie values through CDP, HttpOnly ones included.
    if (cookies !== "off" && !(this.mode === "full" && cookies === "allow")) {
      this.emitCookieSnapshot(reason);
    }

    if (this.capturePolicy.categories.storage !== "off") {
      this.emitLocalStorageSnapshot(reason);
    }

    if (this.capturePolicy.categories.indexedDb !== "off") {
      void this.emitIndexedDbSnapshot(reason);
    }
  }

  private emitCookieSnapshot(reason: string): void {
    this.queueEvent(
      "cookieSnapshot",
      buildCookieSnapshotPayload(reason, this.capturePolicy.categories.cookies)
    );
  }

  private emitLocalStorageSnapshot(reason: string): void {
    const count = localStorage.length;
    const level = this.capturePolicy.categories.storage;

    this.hasLocalStorageSnapshot = true;
    this.queueEvent("localStorageSnapshot", buildLocalStorageSnapshotPayload(reason, level, count));
  }

  private async emitIndexedDbSnapshot(reason: string): Promise<void> {
    // One read at a time: start, interval and stop snapshots must not stack up on the page.
    if (
      this.indexedDbSnapshotInFlight ||
      !("indexedDB" in window) ||
      typeof indexedDB.databases !== "function"
    ) {
      return;
    }

    this.indexedDbSnapshotInFlight = true;

    try {
      await captureIndexedDbSnapshot(reason, {
        level: () => this.capturePolicy.categories.indexedDb,
        isRecording: () => this.recordingActive,
        emit: (payload) => this.queueEvent("indexedDbSnapshot", payload)
      });
    } catch {
      void 0;
    } finally {
      this.indexedDbSnapshotInFlight = false;
    }
  }

  private emitViewportSnapshot(reason: string): void {
    if (!this.isTopLevelFrame) {
      return;
    }

    this.queueEvent("resize", {
      reason,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio
    });
  }

  private emitLifecycleEvent(rawType: string, payload: Record<string, unknown>): void {
    this.queueEvent(rawType, payload);
  }

  private scheduleDeferredStartCapture(delayMs = START_CAPTURE_DEFER_MS): void {
    if (this.startCaptureTimer > 0) {
      clearTimeout(this.startCaptureTimer);
      this.startCaptureTimer = 0;
    }

    if (
      !this.shouldCaptureDomSnapshots() &&
      !this.shouldCaptureStorageSnapshots() &&
      !this.shouldCaptureScreenshots()
    ) {
      return;
    }

    this.startCaptureTimer = window.setTimeout(
      () => {
        this.startCaptureTimer = 0;

        if (!this.recordingActive) {
          return;
        }

        if (this.shouldDeferBackgroundCapture()) {
          this.scheduleDeferredStartCapture(BACKGROUND_CAPTURE_IDLE_MS);
          return;
        }

        if (this.shouldCaptureDomSnapshots()) {
          this.scheduleDeferredStartTask(() => {
            this.emitDomSnapshot("start");
          }, 0);
        }

        if (this.shouldCaptureStorageSnapshots()) {
          this.scheduleDeferredStartTask(() => {
            this.emitStorageSnapshots("start");
          }, START_CAPTURE_STORAGE_DELAY_MS);
        }

        if (this.shouldCaptureScreenshots()) {
          this.scheduleDeferredStartTask(() => {
            this.scheduleScreenshotCapture("start");
          }, START_CAPTURE_SCREENSHOT_DELAY_MS);
        }
      },
      Math.max(0, delayMs)
    );
  }

  private scheduleDeferredStartTask(task: () => void, delayMs: number): void {
    const timerId = window.setTimeout(
      () => {
        this.deferredStartTaskTimers = this.deferredStartTaskTimers.filter(
          (entry) => entry !== timerId
        );

        if (!this.recordingActive || this.shouldDeferBackgroundCapture()) {
          return;
        }

        task();
      },
      Math.max(0, delayMs)
    );

    this.deferredStartTaskTimers.push(timerId);
  }

  private scheduleScreenshotCapture(reason: string, prioritize = false): void {
    if (!this.recordingActive || !this.shouldCaptureScreenshots()) {
      return;
    }

    const isAction = reason.startsWith("action:");

    if (!prioritize && !isAction && this.shouldDeferBackgroundCapture()) {
      this.setPendingScreenshotReason(reason);
      this.scheduleBackgroundCaptureRetry();
      return;
    }

    const nowMono = monotonicTime();

    if (isAction && nowMono - this.lastActionScreenshotMono < SCREENSHOT_ACTION_COOLDOWN_MS) {
      return;
    }

    if (isAction) {
      this.lastActionScreenshotMono = nowMono;
    }

    if (this.screenshotInFlight || this.screenshotCaptureBlocked) {
      this.setPendingScreenshotReason(reason, prioritize);

      return;
    }

    void this.startScreenshotCapture(reason);
  }

  private startScreenshotCapture(reason: string): Promise<void> {
    this.screenshotInFlight = true;

    const capturePromise = this.captureScreenshot(reason).finally(() => {
      this.screenshotInFlight = false;
      this.screenshotInFlightPromise = null;

      this.schedulePendingScreenshotCapture();
    });

    this.screenshotInFlightPromise = capturePromise;
    return capturePromise;
  }

  private async captureScreenshot(reason: string): Promise<void> {
    if (!this.recordingActive || !this.shouldCaptureScreenshots()) {
      return;
    }

    await captureViewportScreenshot(reason, {
      indicator: () => this.indicator,
      onCaptureStarted: () => {
        this.screenshotCaptureBlocked = true;
      },
      onCaptureSettled: () => {
        this.releaseScreenshotCaptureBlock();
      },
      pointer: () => this.readPointerSnapshot(),
      emit: (payload) => {
        this.hasCapturedScreenshot = true;
        this.queueEvent("screenshot", payload);
      }
    });
  }

  private trackPointer(x: number, y: number): void {
    this.lastPointerState = {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      t: Date.now(),
      mono: monotonicTime()
    };
  }

  private markUserActivity(): void {
    this.lastUserActivityMono = monotonicTime();
  }

  private recordEditableInteraction(target: EventTarget | null): void {
    if (!isEditableInteractionTarget(target)) {
      return;
    }

    const nowMono = monotonicTime();
    this.recentEditableInteractionMonos = this.recentEditableInteractionMonos.filter(
      (entry) => nowMono - entry <= INPUT_PRESSURE_BURST_WINDOW_MS
    );
    this.recentEditableInteractionMonos.push(nowMono);

    const richTextTarget = isRichTextEditableTarget(target);
    const duration = richTextTarget
      ? INPUT_PRESSURE_EDITOR_COOLDOWN_MS
      : this.recentEditableInteractionMonos.length >= INPUT_PRESSURE_BURST_COUNT
        ? INPUT_PRESSURE_COOLDOWN_MS
        : 0;

    if (duration <= 0) {
      return;
    }

    this.inputPressureUntilMono = Math.max(this.inputPressureUntilMono, nowMono + duration);

    if (richTextTarget) {
      this.editorPressureUntilMono = Math.max(
        this.editorPressureUntilMono,
        nowMono + INPUT_PRESSURE_EDITOR_COOLDOWN_MS
      );
    }
  }

  private recordScrollPressure(): void {
    if (!this.recordingActive) {
      return;
    }

    const nowMono = monotonicTime();
    this.recentScrollMonos = this.recentScrollMonos.filter(
      (entry) => nowMono - entry <= SCROLL_PRESSURE_WINDOW_MS
    );
    this.recentScrollMonos.push(nowMono);

    if (this.recentScrollMonos.length >= SCROLL_PRESSURE_EVENT_COUNT) {
      this.enterQuietMode("scroll");
    }
  }

  private isUserRecentlyActive(idleMs = BACKGROUND_CAPTURE_IDLE_MS): boolean {
    return monotonicTime() - this.lastUserActivityMono < idleMs;
  }

  private resolveMutationFlushDelay(): number {
    if (!this.isMutationPressureActive()) {
      const stage = this.resolveCapturePressureStage();

      if (stage === "hard" || stage === "critical") {
        return Math.max(Math.round(this.sampling.domFlushMs), MUTATION_PRESSURE_FLUSH_MS);
      }

      return Math.max(25, Math.round(this.sampling.domFlushMs));
    }

    const remainingPressureMs = Math.max(
      0,
      Math.ceil(this.mutationPressureUntilMono - monotonicTime())
    );

    return Math.max(
      Math.max(Math.round(this.sampling.domFlushMs), MUTATION_PRESSURE_FLUSH_MS),
      remainingPressureMs
    );
  }

  private shouldHoldMutationFlush(): boolean {
    const stage = this.resolveCapturePressureStage();
    return (
      this.recordingActive &&
      this.mutationSummary.count > 0 &&
      (stage === "hard" || stage === "critical")
    );
  }

  private extendMutationPressureWindow(): void {
    this.mutationPressureUntilMono = monotonicTime() + MUTATION_PRESSURE_COOLDOWN_MS;
  }

  private extendLongTaskPressure(duration: number): void {
    const cooldownMs =
      duration >= LONG_TASK_PRESSURE_THRESHOLD_MS * 2
        ? LONG_TASK_PRESSURE_EXTENDED_COOLDOWN_MS
        : LONG_TASK_PRESSURE_COOLDOWN_MS;
    this.longTaskPressureUntilMono = Math.max(
      this.longTaskPressureUntilMono,
      monotonicTime() + cooldownMs
    );
  }

  private extendRafPressure(frameGap: number): void {
    const cooldownMs =
      frameGap >= RAF_PRESSURE_GAP_MS * 1.5
        ? LONG_TASK_PRESSURE_COOLDOWN_MS
        : RAF_PRESSURE_COOLDOWN_MS;
    this.rafPressureUntilMono = Math.max(this.rafPressureUntilMono, monotonicTime() + cooldownMs);
  }

  private isMutationPressureActive(): boolean {
    return monotonicTime() < this.mutationPressureUntilMono;
  }

  private isInputPressureActive(): boolean {
    return monotonicTime() < this.inputPressureUntilMono;
  }

  private isEditorPressureActive(): boolean {
    return monotonicTime() < this.editorPressureUntilMono;
  }

  private isQuietModeActive(): boolean {
    return monotonicTime() < this.quietModeUntilMono;
  }

  private isLongTaskPressureActive(): boolean {
    return monotonicTime() < this.longTaskPressureUntilMono;
  }

  private isRafPressureActive(): boolean {
    return monotonicTime() < this.rafPressureUntilMono;
  }

  private resolveCapturePressureStage(): CapturePressureStage {
    if (this.isQuietModeActive() || this.eventBuffer.length >= EVENT_BUFFER_HARD_LIMIT) {
      return "critical";
    }

    if (
      this.isMutationPressureActive() ||
      this.isInputPressureActive() ||
      this.isLongTaskPressureActive() ||
      this.isRafPressureActive() ||
      this.eventBuffer.length >= EVENT_BUFFER_SOFT_LIMIT
    ) {
      return "hard";
    }

    if (this.inputCapture.isScrollBurstActive()) {
      return "soft";
    }

    return "none";
  }

  private shouldDeferBackgroundCapture(): boolean {
    return this.resolveCapturePressureStage() !== "none" || this.isUserRecentlyActive();
  }

  private shouldSuppressPointerMoveCapture(): boolean {
    const stage = this.resolveCapturePressureStage();
    return (
      this.inputCapture.isScrollBurstActive() ||
      stage === "hard" ||
      stage === "critical" ||
      this.eventBuffer.length >= EVENT_BUFFER_FORCE_FLUSH_SIZE
    );
  }

  private resolveDomSnapshotSummaryMode(nodeCount: number): DomSnapshotSummaryMode {
    const stage = this.resolveCapturePressureStage();

    if (stage === "hard" || stage === "critical") {
      return "pressure";
    }

    if (nodeCount >= DOM_SNAPSHOT_SUMMARY_NODE_THRESHOLD) {
      return "large-dom";
    }

    return "runtime-lite";
  }

  private setPendingScreenshotReason(reason: string, prioritize = false): void {
    if (
      prioritize ||
      this.screenshotPendingReason === null ||
      this.screenshotPendingReason === "interval"
    ) {
      this.screenshotPendingReason = reason;
    }
  }

  private releaseScreenshotCaptureBlock(): void {
    this.screenshotCaptureBlocked = false;
    this.schedulePendingScreenshotCapture();
  }

  private schedulePendingScreenshotCapture(): void {
    if (
      this.disposed ||
      !this.recordingActive ||
      this.screenshotInFlight ||
      this.screenshotCaptureBlocked ||
      !this.screenshotPendingReason
    ) {
      return;
    }

    const pending = this.screenshotPendingReason;
    this.screenshotPendingReason = null;
    this.scheduleScreenshotCapture(pending);
  }

  private scheduleBackgroundCaptureRetry(): void {
    if (this.backgroundCaptureRetryTimer > 0 || !this.recordingActive) {
      return;
    }

    this.backgroundCaptureRetryTimer = window.setTimeout(() => {
      this.backgroundCaptureRetryTimer = 0;

      if (!this.recordingActive || !this.screenshotPendingReason) {
        return;
      }

      if (this.shouldDeferBackgroundCapture()) {
        this.scheduleBackgroundCaptureRetry();
        return;
      }

      const pending = this.screenshotPendingReason;
      this.screenshotPendingReason = null;
      this.scheduleScreenshotCapture(pending);
    }, BACKGROUND_CAPTURE_IDLE_MS);
  }

  private ensureMutationObserverActive(): void {
    if (
      this.mutationObserver ||
      !this.recordingActive ||
      !this.shouldCaptureMutationSignals() ||
      this.isQuietModeActive()
    ) {
      return;
    }

    this.mutationObserver = new MutationObserver((records) => {
      if (this.isQuietModeActive()) {
        this.pendingQuietRecoverySummary = true;
        return;
      }

      if (this.shouldEnterQuietMode(records)) {
        this.enterQuietMode(this.isEditorPressureActive() ? "editor" : "mutation");
        return;
      }

      this.accumulateMutationRecords(records);
      this.scheduleMutationFlush();
    });

    this.mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: false,
      attributeFilter: OBSERVED_MUTATION_ATTRIBUTES,
      characterDataOldValue: false,
      attributeOldValue: false
    });
  }

  private shouldEnterQuietMode(records: MutationRecord[]): boolean {
    if (records.length === 0) {
      return false;
    }

    return (
      records.length >= QUIET_MODE_MUTATION_RECORD_LIMIT ||
      this.eventBuffer.length >= QUIET_MODE_EVENT_BUFFER_LIMIT ||
      this.isEditorPressureActive()
    );
  }

  private enterQuietMode(reason: "mutation" | "editor" | "scroll"): void {
    const duration =
      reason === "editor"
        ? QUIET_MODE_EDITOR_COOLDOWN_MS
        : reason === "scroll"
          ? QUIET_MODE_SCROLL_COOLDOWN_MS
          : QUIET_MODE_COOLDOWN_MS;
    this.quietModeUntilMono = Math.max(this.quietModeUntilMono, monotonicTime() + duration);
    this.pendingQuietRecoverySummary = true;

    if (this.mutationFlushTimer > 0) {
      clearTimeout(this.mutationFlushTimer);
      this.mutationFlushTimer = 0;
    }

    if (this.mutationSummary.count > 0) {
      this.flushMutationBuffer();
    }

    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.scheduleQuietModeRecovery();
    this.scheduleDomChangeSnapshot();
  }

  private scheduleQuietModeRecovery(): void {
    if (!this.recordingActive || this.quietModeRecoveryTimer > 0) {
      return;
    }

    const delayMs = Math.max(
      BACKGROUND_CAPTURE_IDLE_MS,
      Math.ceil(this.quietModeUntilMono - monotonicTime())
    );

    this.quietModeRecoveryTimer = window.setTimeout(() => {
      this.quietModeRecoveryTimer = 0;

      if (!this.recordingActive) {
        return;
      }

      if (this.isQuietModeActive() || this.shouldDeferBackgroundCapture()) {
        this.scheduleQuietModeRecovery();
        return;
      }

      this.ensureMutationObserverActive();

      if (this.pendingQuietRecoverySummary && this.shouldCaptureDomSnapshots()) {
        this.pendingQuietRecoverySummary = false;
        this.emitPressureRecoverySnapshot();
      }
    }, delayMs);
  }

  private emitPressureRecoverySnapshot(): void {
    const payload = buildPressureRecoverySnapshotPayload(this.capturePolicy.redaction);

    this.hasDomSnapshot = true;
    this.queueEvent("snapshot", payload);
  }

  private readPointerSnapshot(): Record<string, unknown> | undefined {
    if (!this.lastPointerState) {
      return undefined;
    }

    if (Date.now() - this.lastPointerState.t > SCREENSHOT_POINTER_STALE_MS) {
      return undefined;
    }

    return {
      x: this.lastPointerState.x,
      y: this.lastPointerState.y,
      t: this.lastPointerState.t,
      mono: this.lastPointerState.mono
    };
  }

  private queueEvent(rawType: string, payload: Record<string, unknown>, mono?: number): void {
    const now = monotonicTime();
    const eventMono = mono ?? now;

    this.queueRawEvent({
      source: "content",
      rawType,
      tabId: this.tabId,
      sid: this.sid,
      t: Date.now() - Math.max(0, now - eventMono),
      mono: eventMono,
      frame: this.frameMarker,
      payload
    });
  }

  private queueRawEvent(event: RawRecorderEvent): void {
    if (!shouldPageCapture(event.rawType, this.mode, this.capturePolicy.categories)) {
      return;
    }

    if (!this.recordingActive) {
      this.eventBuffer.bufferBeforeRecording(event);
      return;
    }

    this.eventBuffer.enqueue(event);
  }

  private ensureIndicator(sid?: string, mode?: string): void {
    if (!this.options.showIndicator) {
      return;
    }

    if (!this.indicator) {
      this.indicator = document.createElement("div");
      this.indicator.setAttribute("data-webblackbox-indicator", "true");
      this.indicator.style.position = "fixed";
      this.indicator.style.right = "12px";
      this.indicator.style.bottom = "12px";
      this.indicator.style.zIndex = "2147483647";
      this.indicator.style.padding = "6px 10px";
      this.indicator.style.borderRadius = "8px";
      this.indicator.style.background = "rgba(173, 29, 42, 0.92)";
      this.indicator.style.color = "#fff";
      this.indicator.style.font = "600 12px/1.2 'IBM Plex Sans', sans-serif";
      this.indicator.style.boxShadow = "0 6px 20px rgba(0,0,0,0.22)";
      this.indicator.style.pointerEvents = "none";
      document.documentElement.appendChild(this.indicator);
    }

    const suffix = sid ? ` ${sid.slice(0, 8)}` : "";
    this.indicator.textContent = `WebBlackbox REC ${mode ?? "lite"}${suffix}`;
  }

  private removeIndicator(): void {
    if (!this.indicator) {
      return;
    }

    this.indicator.remove();
    this.indicator = null;
  }

  private listen<TEvent extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: TEvent) => void,
    options?: AddEventListenerOptions
  ): void {
    const wrapped: EventListener = (event) => {
      listener(event as TEvent);
    };

    target.addEventListener(type, wrapped, options);
    this.cleanupCallbacks.push(() => {
      target.removeEventListener(type, wrapped, options);
    });
  }
}

/** Default sanitized sampling profile used by `LiteCaptureAgent`. */
export { DEFAULT_SAMPLING as DEFAULT_LITE_CAPTURE_SAMPLING } from "./lite-capture-config.js";
