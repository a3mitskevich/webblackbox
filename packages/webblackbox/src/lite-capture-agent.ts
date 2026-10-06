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
  isPageEventKeptInFullMode
} from "./capture-scope.js";
import {
  INJECTED_MESSAGE_SOURCE,
  INJECTED_RAW_EVENT_TYPES,
  type InjectedCaptureWindowMessage
} from "./injected-hooks.js";
import {
  SCRIPT_SOURCE_MAP_RAW_TYPE,
  startScriptSourceMapScanner
} from "./script-source-map-scanner.js";
import {
  notePasswordField,
  readCapturableInputValue,
  watchPasswordFieldReveals
} from "./input-value-policy.js";
import { PointerCaptureController, readGeometry } from "./pointer-capture.js";
import { round } from "./pointer-target.js";
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
  installPerformanceObservers,
  LONG_TASK_PRESSURE_THRESHOLD_MS,
  RAF_PRESSURE_GAP_MS
} from "./lite-performance-capture.js";
import {
  buildCookieSnapshotPayload,
  buildLocalStorageSnapshotPayload,
  captureIndexedDbSnapshot
} from "./lite-storage-snapshots.js";
import {
  captureSnapdomDataUrl,
  computeScreenshotScale,
  createSnapdomCaptureOptions,
  withTimeout
} from "./lite-screenshots.js";
import {
  createKeydownPayload,
  isEditableInteractionTarget,
  isRichTextEditableTarget
} from "./lite-keystrokes.js";
import { LiteTargetPayloads, toFastTargetPayload } from "./lite-target-payload.js";

const PRE_RECORDING_BUFFER_MAX = 400;
const SCREENSHOT_MAX_DATA_URL_LENGTH = 10 * 1024 * 1024;
const SCREENSHOT_POINTER_STALE_MS = 2_500;
const SCREENSHOT_ACTION_COOLDOWN_MS = 2_000;
const BACKGROUND_CAPTURE_IDLE_MS = 1_500;
const START_CAPTURE_STORAGE_DELAY_MS = 400;
const START_CAPTURE_SCREENSHOT_DELAY_MS = 1_000;
const SCROLL_BURST_DEBOUNCE_MS = 140;
const SCROLL_PRESSURE_WINDOW_MS = 700;
const SCROLL_PRESSURE_EVENT_COUNT = 6;
const POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS = 220;
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
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 4_000;
const DOM_SNAPSHOT_SUMMARY_NODE_THRESHOLD = 3_500;
const START_CAPTURE_DEFER_MS = 2_000;
const LONG_TASK_PRESSURE_COOLDOWN_MS = 1_800;
const LONG_TASK_PRESSURE_EXTENDED_COOLDOWN_MS = 3_000;
const RAF_PRESSURE_COOLDOWN_MS = 1_400;
const EVENT_BUFFER_FLUSH_DELAY_MS = 180;
const EVENT_BUFFER_FORCE_FLUSH_SIZE = 120;
const EVENT_BUFFER_EMIT_CHUNK_SIZE = 80;
const EVENT_BUFFER_SOFT_LIMIT = 420;
const EVENT_BUFFER_HARD_LIMIT = 1_200;
const MUTATION_DETAIL_RECORD_LIMIT = 160;
const MUTATION_DETAIL_BUFFER_LIMIT = 240;
const PERF_LOG_FLAG = "__WEBBLACKBOX_PERF__";
const INJECTED_RAW_EVENT_TYPE_SET: ReadonlySet<string> = new Set(INJECTED_RAW_EVENT_TYPES);

const LOW_PRIORITY_RAW_TYPES = new Set([
  "mousemove",
  "wheel",
  "hover",
  "scroll",
  "mutation",
  "rrweb",
  "vitals",
  "longtask",
  "snapshot",
  "screenshot"
]);

const FULL_MODE_SKIPPED_RAW_TYPES = new Set([
  "scroll",
  "mutation",
  "snapshot",
  "screenshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot"
]);

const INPUT_OPTIONS_TRUE: AddEventListenerOptions = {
  capture: true
};

const PASSIVE_INPUT_OPTIONS_TRUE: AddEventListenerOptions = {
  capture: true,
  passive: true
};

type CapturePressureStage = "none" | "soft" | "hard" | "critical";

/**
 * Browser-side event capture agent used by `WebBlackboxLiteSdk`.
 * It collects DOM/input/network/error/perf signals and emits buffered raw events.
 */
export class LiteCaptureAgent {
  private readonly eventBuffer: RawRecorderEvent[] = [];
  private readonly preRecordingBuffer: RawRecorderEvent[] = [];
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
  private injectedBridgeNonce: string | null = null;
  private indicator: HTMLDivElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private snapshotTimer = 0;
  private screenshotTimer = 0;
  private startCaptureTimer = 0;
  private backgroundCaptureRetryTimer = 0;
  private quietModeRecoveryTimer = 0;
  private deferredStartTaskTimers: number[] = [];
  private trailingScrollTimer = 0;
  private mutationFlushTimer = 0;

  private domChangeSnapshotTimer = 0;

  private indexedDbSnapshotInFlight = false;

  private lastDomSnapshotMono = Number.NEGATIVE_INFINITY;
  private flushTimer = 0;
  private lastScrollTime = 0;
  private lastPointerTime = Number.NEGATIVE_INFINITY;
  private screenshotInFlight = false;
  private screenshotCaptureBlocked = false;
  private screenshotInFlightPromise: Promise<void> | null = null;
  private screenshotPendingReason: string | null = null;
  private hasCapturedScreenshot = false;
  private lastActionScreenshotMono = Number.NEGATIVE_INFINITY;
  private lastUserActivityMono = monotonicTime();
  private scrollBurstActiveUntilMono = Number.NEGATIVE_INFINITY;
  private mutationPressureUntilMono = Number.NEGATIVE_INFINITY;
  private inputPressureUntilMono = Number.NEGATIVE_INFINITY;
  private editorPressureUntilMono = Number.NEGATIVE_INFINITY;
  private quietModeUntilMono = Number.NEGATIVE_INFINITY;
  private longTaskPressureUntilMono = Number.NEGATIVE_INFINITY;
  private rafPressureUntilMono = Number.NEGATIVE_INFINITY;
  private recentEditableInteractionMonos: number[] = [];
  private recentScrollMonos: number[] = [];
  private lastPointerState: { x: number; y: number; t: number; mono: number } | null = null;
  private pendingScrollPayload: {
    target: Record<string, unknown>;
    scrollX: number;
    scrollY: number;
  } | null = null;
  private lastEmittedScrollPosition: { scrollX: number; scrollY: number } | null = null;
  private hasDomSnapshot = false;
  private hasLocalStorageSnapshot = false;
  private mutationSummary: MutationBatchSummary = createEmptyMutationSummary();
  private droppedLowPriorityEvents = 0;
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
        this.flushPreRecordingBuffer();
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
    this.flushPendingScrollEvent();
    this.drainBufferedEvents();
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

    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    this.runCleanupCallbacks();
    this.targets.clearPendingTargetEnrichmentTimers();
    this.pointerCapture.reset();

    this.eventBuffer.length = 0;
    this.preRecordingBuffer.length = 0;
    this.mutationSummary = createEmptyMutationSummary();
    this.targets.resetSelectorCache();
    this.hasCapturedScreenshot = false;
  }

  private installInjectedMessageBridge(): void {
    this.listen(window, "message", (event: MessageEvent<unknown>) => {
      if (event.source !== window) {
        return;
      }

      const data = event.data as InjectedCaptureWindowMessage | undefined;

      if (!data || data.source !== INJECTED_MESSAGE_SOURCE) {
        return;
      }

      // Page scripts share the window with the injected hooks and can post look-alike
      // messages; once the host set a session nonce, unstamped messages are forgeries.
      if (this.injectedBridgeNonce !== null && data.nonce !== this.injectedBridgeNonce) {
        return;
      }

      if (data.kind === "capture-event" && typeof data.rawType === "string") {
        this.queueInjectedRawEvent(data);
        return;
      }

      if (data.kind === "capture-events" && Array.isArray(data.events)) {
        for (const item of data.events) {
          if (item && typeof item.rawType === "string") {
            this.queueInjectedRawEvent(item);
          }
        }

        return;
      }

      if (data.kind === "marker") {
        this.emitMarker(typeof data.message === "string" ? data.message : "Marker");
      }
    });
  }

  private queueInjectedRawEvent(event: {
    rawType: string;
    payload?: Record<string, unknown>;
    t?: number;
    mono?: number;
  }): void {
    // Only raw types the hooks emit. Script records ("script") make the extension fetch source
    // maps, so they come from the scanner only, never from page-world messages.
    if (!INJECTED_RAW_EVENT_TYPE_SET.has(event.rawType)) {
      return;
    }

    this.queueRawEvent({
      source: "content",
      rawType: event.rawType,
      tabId: this.tabId,
      sid: this.sid,
      t: typeof event.t === "number" ? event.t : Date.now(),
      mono: typeof event.mono === "number" ? event.mono : monotonicTime(),
      payload: event.payload ?? {}
    });
  }

  private installInputAndLifecycleCapture(): void {
    this.pointerCapture.install();

    this.listen(
      document,
      "wheel",
      (event: WheelEvent) => {
        this.markUserActivity();

        if (this.mode === "full") {
          return;
        }

        if (Math.abs(event.deltaX) + Math.abs(event.deltaY) <= 0) {
          return;
        }

        this.recordScrollPressure();
      },
      PASSIVE_INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "click",
      (event: MouseEvent) => {
        this.markUserActivity();
        this.trackPointer(event.clientX, event.clientY);
        const mono = monotonicTime();
        this.queueEvent("click", this.createClickPayload(event), mono);
        this.pointerCapture.onClick(mono);
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "dblclick",
      (event: MouseEvent) => {
        this.markUserActivity();
        this.trackPointer(event.clientX, event.clientY);
        this.queueEvent("dblclick", this.createClickPayload(event));
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "keydown",
      (event: KeyboardEvent) => {
        this.markUserActivity();
        this.recordEditableInteraction(event.target);
        notePasswordField(event.target);
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
          this.emitMarker("Keyboard marker");
        }

        this.queueEvent(
          "keydown",
          createKeydownPayload(event, this.capturePolicy, (target) =>
            this.targets.resolveTargetPayload(target, "fast")
          )
        );
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "input",
      (event: Event) => {
        this.markUserActivity();
        const target = event.target;

        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
          return;
        }

        this.recordEditableInteraction(target);

        const value = readCapturableInputValue(target, this.capturePolicy);

        this.queueEvent("input", {
          inputType: target.type,
          length: target.value.length,
          ...(value === undefined ? { valueRedacted: true } : { value }),
          target: this.targets.resolveTargetPayload(target, "input")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "change",
      (event: Event) => {
        this.markUserActivity();
        this.recordEditableInteraction(event.target);
        this.queueEvent("input", {
          kind: "change",
          target: this.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "focus",
      (event: FocusEvent) => {
        this.markUserActivity();
        notePasswordField(event.target);
        this.queueEvent("focus", {
          target: this.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "blur",
      (event: FocusEvent) => {
        this.markUserActivity();
        this.queueEvent("blur", {
          target: this.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "submit",
      (event: Event) => {
        this.markUserActivity();
        this.queueEvent("submit", {
          target: this.targets.resolveTargetPayload(event.target, "fast")
        });
      },
      INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "scroll",
      (event: Event) => {
        this.markUserActivity();
        if (this.mode === "full") {
          return;
        }

        this.recordScrollPressure();

        const now = performance.now();
        const scrollGapMs = Math.max(16, Math.round(1000 / Math.max(1, this.sampling.scrollHz)));

        if (now - this.lastScrollTime < scrollGapMs) {
          this.queueTrailingScrollEvent(event);
          return;
        }

        this.lastScrollTime = now;
        this.scrollBurstActiveUntilMono =
          monotonicTime() + Math.max(POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS, scrollGapMs);

        const payload = {
          target: toFastTargetPayload(event.target, this.targets.selectorSalt()),
          scrollX: window.scrollX,
          scrollY: window.scrollY
        };

        this.pendingScrollPayload = payload;
        this.emitQueuedScrollEvent(payload);
        this.scheduleTrailingScrollFlush(scrollGapMs);
      },
      PASSIVE_INPUT_OPTIONS_TRUE
    );

    this.listen(
      document,
      "pointermove",
      (event: PointerEvent) => {
        this.pointerCapture.onPointerMove(event);
        const now = performance.now();
        const pointerGapMs = Math.max(
          16,
          Math.round(1000 / Math.max(1, this.sampling.mousemoveHz))
        );

        // Full mode keeps page-side work minimal: nothing runs between samples, even while
        // capture is suppressed, so the sample clock advances before the pressure check.
        if (this.mode === "full") {
          if (now - this.lastPointerTime < pointerGapMs) {
            return;
          }

          this.lastPointerTime = now;
        }

        this.markUserActivity();
        this.trackPointer(event.clientX, event.clientY);

        if (this.shouldSuppressPointerMoveCapture()) {
          return;
        }

        if (this.mode !== "full") {
          if (now - this.lastPointerTime < pointerGapMs) {
            return;
          }

          this.lastPointerTime = now;
        }

        this.queueEvent("mousemove", {
          x: round(event.clientX),
          y: round(event.clientY),
          target: toFastTargetPayload(event.target, this.targets.selectorSalt())
        });
      },
      PASSIVE_INPUT_OPTIONS_TRUE
    );

    this.listen(window, "resize", () => {
      this.markUserActivity();
      this.emitViewportSnapshot("resize");
    });

    this.listen(document, "visibilitychange", () => {
      this.markUserActivity();
      this.emitLifecycleEvent("visibilitychange", {
        state: document.visibilityState
      });
    });
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

    if (this.trailingScrollTimer > 0) {
      clearTimeout(this.trailingScrollTimer);
      this.trailingScrollTimer = 0;
    }

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

    this.flushPendingScrollEvent();
  }

  private ensureCaptureInstalled(): void {
    if (this.captureInstalled) {
      return;
    }

    this.installInputAndLifecycleCapture();

    if (this.isTopLevelFrame) {
      this.installPerformanceCapture();
    }

    this.installInjectedMessageBridge();
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

    const root = document.documentElement;
    const viewportWidth = Math.max(1, Math.round(window.innerWidth));
    const viewportHeight = Math.max(1, Math.round(window.innerHeight));
    const scale = computeScreenshotScale(
      viewportWidth,
      viewportHeight,
      window.devicePixelRatio || 1
    );
    const captureWidth = Math.max(1, Math.round(viewportWidth * scale));
    const captureHeight = Math.max(1, Math.round(viewportHeight * scale));
    const snapdomCaptureOptions = createSnapdomCaptureOptions(scale);

    const previousIndicatorVisibility = this.indicator?.style.visibility;

    if (this.indicator) {
      this.indicator.style.visibility = "hidden";
    }

    try {
      const captureTask = captureSnapdomDataUrl(root, snapdomCaptureOptions, {
        width: captureWidth,
        height: captureHeight
      });
      this.screenshotCaptureBlocked = true;
      void captureTask.then(
        () => {
          this.releaseScreenshotCaptureBlock();
        },
        () => {
          this.releaseScreenshotCaptureBlock();
        }
      );

      const screenshot = await withTimeout(captureTask, SCREENSHOT_CAPTURE_TIMEOUT_MS);

      if (
        !screenshot ||
        typeof screenshot.dataUrl !== "string" ||
        screenshot.dataUrl.length > SCREENSHOT_MAX_DATA_URL_LENGTH
      ) {
        return;
      }

      this.hasCapturedScreenshot = true;

      this.queueEvent("screenshot", {
        reason,
        dataUrl: screenshot.dataUrl,
        format: screenshot.format,
        quality: screenshot.quality,
        w: captureWidth,
        h: captureHeight,
        viewport: {
          width: viewportWidth,
          height: viewportHeight,
          dpr: Number((window.devicePixelRatio || 1).toFixed(3))
        },
        pointer: this.readPointerSnapshot()
      });
    } catch {
      void 0;
    } finally {
      if (this.indicator) {
        this.indicator.style.visibility = previousIndicatorVisibility ?? "";
      }
    }
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

  private queueTrailingScrollEvent(event: Event): void {
    this.pendingScrollPayload = {
      target: toFastTargetPayload(event.target, this.targets.selectorSalt()),
      scrollX: window.scrollX,
      scrollY: window.scrollY
    };
    this.scrollBurstActiveUntilMono = monotonicTime() + POINTERMOVE_SUPPRESS_AFTER_SCROLL_MS;
    this.scheduleTrailingScrollFlush(SCROLL_BURST_DEBOUNCE_MS);
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

  private scheduleTrailingScrollFlush(delayMs: number): void {
    if (this.trailingScrollTimer > 0) {
      clearTimeout(this.trailingScrollTimer);
    }

    this.trailingScrollTimer = window.setTimeout(
      () => {
        this.trailingScrollTimer = 0;
        this.flushPendingScrollEvent();
      },
      Math.max(SCROLL_BURST_DEBOUNCE_MS, delayMs)
    );
  }

  private flushPendingScrollEvent(): void {
    const pending = this.pendingScrollPayload;

    if (!pending) {
      return;
    }

    this.pendingScrollPayload = null;

    if (
      this.lastEmittedScrollPosition &&
      this.lastEmittedScrollPosition.scrollX === pending.scrollX &&
      this.lastEmittedScrollPosition.scrollY === pending.scrollY
    ) {
      return;
    }

    this.emitQueuedScrollEvent(pending);
  }

  private emitQueuedScrollEvent(payload: {
    target: Record<string, unknown>;
    scrollX: number;
    scrollY: number;
  }): void {
    this.lastEmittedScrollPosition = {
      scrollX: payload.scrollX,
      scrollY: payload.scrollY
    };

    this.queueEvent("scroll", payload);
  }

  private isScrollBurstActive(): boolean {
    return monotonicTime() < this.scrollBurstActiveUntilMono;
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

    if (this.isScrollBurstActive()) {
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
      this.isScrollBurstActive() ||
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
    if (
      this.mode === "full" &&
      FULL_MODE_SKIPPED_RAW_TYPES.has(event.rawType) &&
      !isPageEventKeptInFullMode(event.rawType, this.capturePolicy.categories)
    ) {
      return;
    }

    if (!this.recordingActive) {
      if (shouldBufferBeforeRecording(event)) {
        this.preRecordingBuffer.push(event);

        if (this.preRecordingBuffer.length > PRE_RECORDING_BUFFER_MAX) {
          this.preRecordingBuffer.splice(
            0,
            this.preRecordingBuffer.length - PRE_RECORDING_BUFFER_MAX
          );
        }
      }

      return;
    }

    if (this.shouldDropEventForBackpressure(event)) {
      return;
    }

    this.eventBuffer.push(event);
    this.scheduleBufferedFlush(
      this.eventBuffer.length >= EVENT_BUFFER_FORCE_FLUSH_SIZE ? 0 : EVENT_BUFFER_FLUSH_DELAY_MS
    );
  }

  private createClickPayload(event: MouseEvent): Record<string, unknown> {
    return {
      x: round(event.clientX),
      y: round(event.clientY),
      pageX: round(event.pageX),
      pageY: round(event.pageY),
      ...readGeometry(),
      button: event.button,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      target: this.targets.createPointerTargetPayload(event.target, "rich")
    };
  }

  private flushPreRecordingBuffer(): void {
    if (!this.recordingActive || this.preRecordingBuffer.length === 0) {
      return;
    }

    this.eventBuffer.push(...this.preRecordingBuffer.splice(0, this.preRecordingBuffer.length));
    this.scheduleBufferedFlush(0);
  }

  private flushEvents(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer.splice(0, EVENT_BUFFER_EMIT_CHUNK_SIZE);

    if (events.length > 0) {
      this.options.emitBatch(events);
    }

    if (this.eventBuffer.length > 0) {
      this.scheduleBufferedFlush(0);
    }
  }

  private scheduleBufferedFlush(delayMs: number): void {
    if (this.flushTimer > 0) {
      if (delayMs > 0) {
        return;
      }

      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    this.flushTimer = window.setTimeout(
      () => {
        this.flushEvents();
      },
      Math.max(0, delayMs)
    );
  }

  private drainBufferedEvents(): void {
    if (this.flushTimer > 0) {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.eventBuffer.length === 0) {
      return;
    }

    while (this.eventBuffer.length > 0) {
      const events = this.eventBuffer.splice(0, EVENT_BUFFER_EMIT_CHUNK_SIZE);

      if (events.length === 0) {
        break;
      }

      this.options.emitBatch(events);
    }
  }

  private shouldDropEventForBackpressure(event: RawRecorderEvent): boolean {
    const buffered = this.eventBuffer.length;

    if (buffered < EVENT_BUFFER_SOFT_LIMIT) {
      return false;
    }

    if (!LOW_PRIORITY_RAW_TYPES.has(event.rawType)) {
      return false;
    }

    if (buffered < EVENT_BUFFER_SOFT_LIMIT) {
      return false;
    }

    if (buffered >= EVENT_BUFFER_HARD_LIMIT || this.mode === "full") {
      if (buffered >= EVENT_BUFFER_HARD_LIMIT && this.mode !== "full") {
        this.dropBufferedLowPriorityEvents(buffered - EVENT_BUFFER_SOFT_LIMIT + 1);
        this.scheduleBufferedFlush(0);
      }

      this.droppedLowPriorityEvents += 1;

      if (isPerfLoggingEnabled() && this.droppedLowPriorityEvents % 200 === 0) {
        console.info("[WebBlackbox][perf] dropped low-priority events", {
          mode: this.mode,
          dropped: this.droppedLowPriorityEvents,
          buffered,
          rawType: event.rawType
        });
      }

      return true;
    }

    return false;
  }

  private dropBufferedLowPriorityEvents(targetDropCount: number): void {
    if (targetDropCount <= 0 || this.eventBuffer.length === 0) {
      return;
    }

    let dropped = 0;
    const retained: RawRecorderEvent[] = [];

    for (const event of this.eventBuffer) {
      if (dropped < targetDropCount && LOW_PRIORITY_RAW_TYPES.has(event.rawType)) {
        dropped += 1;
        continue;
      }

      retained.push(event);
    }

    if (dropped === 0) {
      return;
    }

    this.eventBuffer.length = 0;
    this.eventBuffer.push(...retained);
    this.droppedLowPriorityEvents += dropped;
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

function isPerfLoggingEnabled(): boolean {
  const flags = window as unknown as Record<string, unknown>;
  return flags[PERF_LOG_FLAG] === true;
}

function shouldBufferBeforeRecording(event: RawRecorderEvent): boolean {
  if (event.source !== "content") {
    return false;
  }

  return (
    event.rawType === "console" ||
    event.rawType === "fetch" ||
    event.rawType === "xhr" ||
    event.rawType === "networkBody" ||
    event.rawType === "fetchError" ||
    event.rawType === "pageError" ||
    event.rawType === "unhandledrejection" ||
    event.rawType === "resourceError"
  );
}

/** Default sanitized sampling profile used by `LiteCaptureAgent`. */
export { DEFAULT_SAMPLING as DEFAULT_LITE_CAPTURE_SAMPLING } from "./lite-capture-config.js";
