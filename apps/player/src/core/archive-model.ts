import type { WebBlackboxEvent } from "@webblackbox/protocol";
import {
  type ActionSpan,
  type ActionTimelineEntry,
  type NetworkWaterfallEntry,
  type PerformanceArtifactEntry,
  type RealtimeNetworkEntry,
  type ReplayDiagnosticEntry,
  type StorageTimelineEntry,
  buildPointerTimeline,
  detectPointerSignals,
  type TabsContext,
  readTabsContext,
  type WebBlackboxPlayer
} from "@webblackbox/player-sdk";

import { normalizePlaybackEvents, type PlaybackTimeNormalization } from "../lib/playback-time.js";
import {
  buildPointerLaneMarks,
  toOverlayActions,
  type OverlayPointerAction,
  type PointerLaneKind,
  type PointerLaneMark
} from "../lib/pointer-overlay.js";
import { asFiniteNumber, asRecord, asString } from "../lib/parsing.js";
import { isConsolePrivacyViolation } from "../lib/recording-profile-view.js";
import {
  buildActionScopeIndex,
  extractReqIdFromEvent,
  inferEventScope,
  mergeEventScopes,
  type EventScope
} from "../lib/scope.js";
import {
  readScreenshotContext,
  readScreenshotMarker,
  readScreenshotShotId
} from "../lib/screenshot-data.js";
import { buildActionSearchText, buildEventSearchText } from "../lib/search-text.js";
import { buildConsoleSignalSearchText } from "../lib/signal-text.js";
import { buildViewportTimeline, type ViewportSample } from "./viewport-fit.js";
import { isTabLifecycleEvent } from "../lib/tabs-context-view.js";

/**
 * The playback model of one archive: events on the normalized playback clock plus every index the
 * player reads per frame. Framework-agnostic; built once per opened archive.
 */

/** Locale-dependent labels baked into pointer samples and pointer-lane marks. */
export type ArchiveModelLabels = {
  pointerReasonClick: string;
  pointerReasonMove: string;
  formatPointerKind: (kind: PointerLaneKind) => string;
};

export type ScreenshotMarker = {
  x: number;
  y: number;
  viewportWidth?: number;
  viewportHeight?: number;
  reason?: string;
};

export type ScreenshotTrailPoint = {
  x: number;
  y: number;
  mono: number;
  click: boolean;
};

export type ScreenshotRenderContext = {
  mono: number | null;
  viewportWidth?: number;
  viewportHeight?: number;
};

export type ProgressMarkerKind =
  | "error"
  | "network"
  | "screenshot"
  | "recording"
  | "action"
  | "tabs";

export type ProgressMarker = {
  mono: number;
  kind: ProgressMarkerKind;
};
export type PointerSample = {
  mono: number;
  x: number;
  y: number;
  click: boolean;
  reason?: string;
  viewportWidth?: number;
  viewportHeight?: number;
};

export type ScreenshotRecord = {
  eventId: string;
  mono: number;
  shotId: string;
  reason: string | null;
  format: string | null;
  size: number | null;
  marker: ScreenshotMarker | null;
  context: ScreenshotRenderContext | null;
};

export type ScreenRecordingRecord = {
  eventId: string;
  recordingId: string;
  source: string | null;
  mime: string;
  startMono: number;
  endMono: number;
  durationMs: number;
  chunks: string[];
  chunkCount: number;
  size: number | null;
  width?: number;
  height?: number;
};

export type ArchiveModel = {
  events: WebBlackboxEvent[];
  eventScopeById: Map<string, EventScope>;
  actionTimeline: ActionTimelineEntry[];
  actionScopeByActId: Map<string, EventScope>;
  actionSearchText: string[];
  replayDiagnostics: ReplayDiagnosticEntry[];
  replayDiagnosticByActId: Map<string, ReplayDiagnosticEntry>;
  consoleSignals: WebBlackboxEvent[];
  consoleSignalSearchText: string[];
  eventById: Map<string, WebBlackboxEvent>;
  eventSearchText: string[];
  errorPrefix: number[];
  requestPrefix: number[];
  screenshots: ScreenshotRecord[];
  shotByEventId: Map<string, ScreenshotRecord>;
  screenRecordings: ScreenRecordingRecord[];
  screenRecordingById: Map<string, ScreenRecordingRecord>;
  pointers: PointerSample[];
  /** The page viewport over time (top frame): maps pointer coordinates onto the stage media. */
  viewports: ViewportSample[];
  pointerActions: OverlayPointerAction[];
  pointerLane: PointerLaneMark[];
  waterfall: NetworkWaterfallEntry[];
  waterfallByReqId: Map<string, NetworkWaterfallEntry>;
  requestScopeByReqId: Map<string, EventScope>;
  realtime: RealtimeNetworkEntry[];
  storage: StorageTimelineEntry[];
  perf: PerformanceArtifactEntry[];
  progressMarkers: ProgressMarker[];
  /** Other tabs of the recorded site (empty for archives without them). */
  tabsContext: TabsContext;
  minMono: number;
  maxMono: number;
  durationMono: number;
  totals: {
    events: number;
    errors: number;
    requests: number;
    actionSpans: number;
  };
};

const MAX_PROGRESS_MARKERS_PER_KIND = 120;

const POINTER_SAMPLE_TYPES = new Set<string>([
  "user.mousemove",
  "user.click",
  "user.dblclick",
  "user.contextmenu",
  "user.auxclick"
]);

const ACTION_MARKER_TYPES = new Set([
  "user.click",
  "user.dblclick",
  "user.keydown",
  "user.submit",
  "user.marker"
]);

export function isErrorEvent(event: WebBlackboxEvent): boolean {
  return event.type.startsWith("error.") || event.lvl === "error";
}

export function buildArchiveModel(
  player: WebBlackboxPlayer,
  labels: ArchiveModelLabels
): ArchiveModel {
  const timeNormalization = normalizePlaybackEvents(player.events);
  const events = timeNormalization.events;
  const rawActionTimeline = player.getActionTimeline();
  const derived = player.buildDerived();
  const consoleSignals: WebBlackboxEvent[] = [];
  const consoleSignalSearchText: string[] = [];
  const eventById = new Map<string, WebBlackboxEvent>();
  const eventScopeById = new Map<string, EventScope>();
  const eventSearchText: string[] = [];
  const errorPrefix: number[] = [];
  const requestPrefix: number[] = [];
  const screenshots: ScreenshotRecord[] = [];
  const shotByEventId = new Map<string, ScreenshotRecord>();
  const screenRecordingStarts = new Map<
    string,
    {
      eventId: string;
      mono: number;
      source: string | null;
      mime: string | null;
      width?: number;
      height?: number;
    }
  >();
  const screenRecordings: ScreenRecordingRecord[] = [];
  const screenRecordingById = new Map<string, ScreenRecordingRecord>();
  const pointers: PointerSample[] = [];
  const requestScopeByReqId = new Map<string, EventScope>();

  let errorCount = 0;
  let requestCount = 0;

  for (const event of events) {
    const scope = inferEventScope(event);

    eventById.set(event.id, event);
    eventScopeById.set(event.id, scope);

    if (isErrorEvent(event)) {
      errorCount += 1;
      consoleSignals.push(event);
      consoleSignalSearchText.push(buildConsoleSignalSearchText(event));
    } else if (event.type.startsWith("console.") || isConsolePrivacyViolation(event)) {
      consoleSignals.push(event);
      consoleSignalSearchText.push(buildConsoleSignalSearchText(event));
    }

    if (event.type === "network.request") {
      requestCount += 1;
    }

    const reqId = extractReqIdFromEvent(event);

    if (reqId) {
      requestScopeByReqId.set(reqId, mergeEventScopes(requestScopeByReqId.get(reqId), scope));
    }

    errorPrefix.push(errorCount);
    requestPrefix.push(requestCount);
    eventSearchText.push(
      `${buildEventSearchText(event)} ${scope} ${event.cdp ?? ""} ${event.frame ?? ""}`.toLowerCase()
    );

    const data = asRecord(event.data);

    if (event.type === "screen.screenshot") {
      const shotId = readScreenshotShotId(event, data);

      if (shotId) {
        const shot: ScreenshotRecord = {
          eventId: event.id,
          mono: event.mono,
          shotId,
          reason: typeof data?.reason === "string" ? data.reason : null,
          format: typeof data?.format === "string" ? data.format : null,
          size: asFiniteNumber(data?.size),
          marker: readScreenshotMarker(data),
          context: readScreenshotContext(data, event)
        };

        screenshots.push(shot);
        shotByEventId.set(shot.eventId, shot);
      }
    }

    if (event.type === "screen.recording.start") {
      const recordingId = asString(data?.recordingId);

      if (recordingId) {
        screenRecordingStarts.set(recordingId, {
          eventId: event.id,
          mono: event.mono,
          source: asString(data?.source),
          mime: asString(data?.mime),
          width: normalizePositiveInteger(data?.width),
          height: normalizePositiveInteger(data?.height)
        });
      }
    }

    if (event.type === "screen.recording.end") {
      const recording = readScreenRecordingRecord(
        event,
        data,
        screenRecordingStarts.get(asString(data?.recordingId) ?? "")
      );

      if (recording) {
        screenRecordings.push(recording);
        screenRecordingById.set(recording.recordingId, recording);
      }
    }

    if (POINTER_SAMPLE_TYPES.has(event.type)) {
      const x = asFiniteNumber(data?.x);
      const y = asFiniteNumber(data?.y);

      if (x === null || y === null) {
        continue;
      }

      // Same-origin iframes record frame-relative points; the stage shows the top viewport.
      const frameOffset = asRecord(data?.frameOffset);
      const viewport = asRecord(data?.viewport);
      const viewportWidth = asFiniteNumber(viewport?.w);
      const viewportHeight = asFiniteNumber(viewport?.h);
      const click = event.type !== "user.mousemove";
      pointers.push({
        mono: event.mono,
        x: x + (asFiniteNumber(frameOffset?.x) ?? 0),
        y: y + (asFiniteNumber(frameOffset?.y) ?? 0),
        click,
        reason: click ? labels.pointerReasonClick : labels.pointerReasonMove,
        ...(viewportWidth !== null && viewportHeight !== null && frameOffset === null
          ? { viewportWidth, viewportHeight }
          : {})
      });
    }
  }

  screenshots.sort((left, right) => left.mono - right.mono);
  screenRecordings.sort((left, right) => left.startMono - right.startMono);
  pointers.sort((left, right) => left.mono - right.mono);

  const waterfall = player
    .getNetworkWaterfall()
    .map((entry) => normalizeWaterfallEntry(entry, timeNormalization))
    .sort((left, right) => left.startMono - right.startMono);
  const waterfallByReqId = new Map<string, NetworkWaterfallEntry>();

  for (const entry of waterfall) {
    waterfallByReqId.set(entry.reqId, entry);
  }

  const actionSpanById = new Map(derived.actionSpans.map((span) => [span.actId, span]));
  const actionTimeline = rawActionTimeline
    .map((entry) =>
      normalizeActionTimelineEntry(entry, actionSpanById, timeNormalization, screenshots)
    )
    .sort((left, right) => left.startMono - right.startMono);
  const actionSearchText = actionTimeline.map((entry) => buildActionSearchText(entry));
  const replayDiagnostics = player.getReplayDiagnostics({
    actions: actionTimeline,
    waterfall
  });
  const replayDiagnosticByActId = new Map(
    replayDiagnostics.map((entry) => [entry.actId, entry] as const)
  );
  const actionScopeByActId = buildActionScopeIndex(
    derived.actionSpans,
    eventById,
    requestScopeByReqId
  );
  const minMono = events[0]?.mono ?? 0;
  const maxMono = events[events.length - 1]?.mono ?? 0;
  const progressMarkers = buildProgressMarkers(events, minMono, maxMono);
  const pointerTimeline = buildPointerTimeline(events);
  const pointerActions = toOverlayActions(pointerTimeline);
  const pointerLane = buildPointerLaneMarks(
    pointerTimeline,
    detectPointerSignals(events, {
      captureMonoOf: (event) => timeNormalization.rawMonoByEventId.get(event.id) ?? event.mono
    }),
    labels.formatPointerKind
  );

  return {
    events,
    eventScopeById,
    actionTimeline,
    actionScopeByActId,
    actionSearchText,
    replayDiagnostics,
    replayDiagnosticByActId,
    consoleSignals,
    consoleSignalSearchText,
    eventById,
    eventSearchText,
    errorPrefix,
    requestPrefix,
    screenshots,
    shotByEventId,
    screenRecordings,
    screenRecordingById,
    pointers,
    viewports: buildViewportTimeline(events),
    waterfall,
    waterfallByReqId,
    requestScopeByReqId,
    realtime: player
      .getRealtimeNetworkTimeline()
      .map((entry) => ({
        ...entry,
        mono: normalizeMonoForEvent(entry.eventId, timeNormalization, entry.mono)
      }))
      .sort((left, right) => left.mono - right.mono),
    storage: player
      .getStorageTimeline()
      .map((entry) => ({
        ...entry,
        mono: normalizeMonoForEvent(entry.eventId, timeNormalization, entry.mono)
      }))
      .sort((left, right) => left.mono - right.mono),
    perf: player
      .getPerformanceArtifacts()
      .map((entry) => ({
        ...entry,
        mono: normalizeMonoForEvent(entry.eventId, timeNormalization, entry.mono)
      }))
      .sort((left, right) => left.mono - right.mono),
    progressMarkers,
    pointerActions,
    pointerLane,
    tabsContext: readTabsContext(events),
    minMono,
    maxMono,
    durationMono: Math.max(0, maxMono - minMono),
    totals: {
      events: derived.totals.events,
      errors: derived.totals.errors,
      requests: derived.totals.requests,
      actionSpans: derived.actionSpans.length
    }
  };
}

function readScreenRecordingRecord(
  event: WebBlackboxEvent,
  data: Record<string, unknown> | null,
  start:
    | {
        eventId: string;
        mono: number;
        source: string | null;
        mime: string | null;
        width?: number;
        height?: number;
      }
    | undefined
): ScreenRecordingRecord | null {
  const recordingId = asString(data?.recordingId);
  const chunks = readStringList(data?.chunks);

  if (!recordingId || chunks.length === 0) {
    return null;
  }

  const durationMs = Math.max(0, Math.round(asFiniteNumber(data?.durationMs) ?? 0));
  const fallbackStartMono = durationMs > 0 ? Math.max(0, event.mono - durationMs) : event.mono;
  const startMono = typeof start?.mono === "number" ? start.mono : fallbackStartMono;
  const endMono = Math.max(event.mono, startMono);
  const width = normalizePositiveInteger(data?.width) ?? start?.width;
  const height = normalizePositiveInteger(data?.height) ?? start?.height;

  return {
    eventId: event.id,
    recordingId,
    source: start?.source ?? null,
    mime: asString(data?.mime) ?? start?.mime ?? "video/webm",
    startMono,
    endMono,
    durationMs: Math.max(durationMs, Math.round(endMono - startMono)),
    chunks,
    chunkCount: Math.max(
      chunks.length,
      Math.max(0, Math.round(asFiniteNumber(data?.chunkCount) ?? chunks.length))
    ),
    size: asFiniteNumber(data?.size),
    width,
    height
  };
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function normalizeWaterfallEntry(
  entry: NetworkWaterfallEntry,
  timeNormalization: PlaybackTimeNormalization
): NetworkWaterfallEntry {
  const eventMonos = entry.eventIds
    .map((eventId) => timeNormalization.monoByEventId.get(eventId))
    .filter((mono): mono is number => typeof mono === "number" && Number.isFinite(mono))
    .sort((left, right) => left - right);

  if (eventMonos.length === 0) {
    return entry;
  }

  const startMono = eventMonos[0] ?? entry.startMono;
  const eventEndMono = eventMonos[eventMonos.length - 1] ?? startMono;
  const eventDurationMs = Math.max(0, eventEndMono - startMono);
  const durationMs =
    timeNormalization.source === "wall-clock" && eventMonos.length > 1
      ? eventDurationMs
      : entry.durationMs;
  const endMono = Math.max(eventEndMono, startMono + Math.max(0, durationMs));

  return {
    ...entry,
    startMono,
    endMono,
    durationMs: Math.max(0, durationMs)
  };
}

function normalizeActionTimelineEntry(
  entry: ActionTimelineEntry,
  actionSpanById: Map<string, ActionSpan>,
  timeNormalization: PlaybackTimeNormalization,
  screenshots: ScreenshotRecord[]
): ActionTimelineEntry {
  const span = actionSpanById.get(entry.actId);
  const spanMonos =
    span?.eventIds
      .map((eventId) => timeNormalization.monoByEventId.get(eventId))
      .filter((mono): mono is number => typeof mono === "number" && Number.isFinite(mono)) ?? [];
  const triggerMono = normalizeMonoForEvent(
    entry.triggerEventId,
    timeNormalization,
    entry.startMono
  );
  const startMono = spanMonos.length > 0 ? Math.min(...spanMonos) : triggerMono;
  const endMono =
    spanMonos.length > 0
      ? Math.max(...spanMonos)
      : Math.max(startMono, normalizeMonoValue(entry.endMono, timeNormalization));
  const normalizedErrors = entry.errors.map((error) => ({
    ...error,
    mono: normalizeMonoForEvent(error.eventId, timeNormalization, error.mono)
  }));
  const screenshot = entry.screenshot
    ? {
        ...entry.screenshot,
        mono: normalizeMonoForEvent(
          entry.screenshot.eventId,
          timeNormalization,
          entry.screenshot.mono
        )
      }
    : findScreenshotForNormalizedAction(startMono, endMono, screenshots);

  return {
    ...entry,
    startMono,
    endMono,
    durationMs: Number(Math.max(0, endMono - startMono).toFixed(2)),
    errors: normalizedErrors,
    screenshot
  };
}

function findScreenshotForNormalizedAction(
  startMono: number,
  endMono: number,
  screenshots: ScreenshotRecord[]
): ActionTimelineEntry["screenshot"] {
  const inSpan = screenshots.filter((shot) => shot.mono >= startMono && shot.mono <= endMono);
  const afterSpan = screenshots.find((shot) => shot.mono > endMono && shot.mono <= endMono + 2_000);
  const shot = inSpan[inSpan.length - 1] ?? afterSpan;

  if (!shot) {
    return null;
  }

  return {
    eventId: shot.eventId,
    mono: shot.mono,
    shotId: shot.shotId,
    reason: shot.reason,
    format: shot.format,
    size: shot.size
  };
}

function normalizeMonoForEvent(
  eventId: string,
  timeNormalization: PlaybackTimeNormalization,
  fallbackMono: number
): number {
  return (
    timeNormalization.monoByEventId.get(eventId) ??
    normalizeMonoValue(fallbackMono, timeNormalization)
  );
}

function normalizeMonoValue(mono: number, timeNormalization: PlaybackTimeNormalization): number {
  if (timeNormalization.source === "mono") {
    return mono;
  }

  for (const [eventId, rawMono] of timeNormalization.rawMonoByEventId.entries()) {
    if (Math.abs(rawMono - mono) < 0.001) {
      return timeNormalization.monoByEventId.get(eventId) ?? mono;
    }
  }

  return mono;
}

export function buildProgressMarkers(
  events: WebBlackboxEvent[],
  minMono: number,
  maxMono: number
): ProgressMarker[] {
  if (events.length === 0) {
    return [];
  }

  const buckets: Record<ProgressMarkerKind, number[]> = {
    error: [],
    network: [],
    screenshot: [],
    recording: [],
    action: [],
    tabs: []
  };

  for (const event of events) {
    if (isErrorEvent(event)) {
      buckets.error.push(event.mono);
      continue;
    }

    if (event.type === "network.request") {
      buckets.network.push(event.mono);
      continue;
    }

    if (event.type === "screen.screenshot") {
      buckets.screenshot.push(event.mono);
      continue;
    }

    if (event.type === "screen.recording.start" || event.type === "screen.recording.end") {
      buckets.recording.push(event.mono);
      continue;
    }

    if (isTabLifecycleEvent(event)) {
      buckets.tabs.push(event.mono);
      continue;
    }

    if (ACTION_MARKER_TYPES.has(event.type)) {
      buckets.action.push(event.mono);
    }
  }

  const durationMono = Math.max(0, maxMono - minMono);
  const markers: ProgressMarker[] = [];

  for (const kind of Object.keys(buckets) as ProgressMarkerKind[]) {
    const sampled = compactMarkerMonos(buckets[kind], durationMono);

    for (const mono of sampled) {
      markers.push({
        mono,
        kind
      });
    }
  }

  return markers.sort((left, right) => left.mono - right.mono);
}

function compactMarkerMonos(monos: number[], durationMono: number): number[] {
  if (monos.length === 0) {
    return [];
  }

  const sorted = [...monos].sort((left, right) => left - right);
  const minGap = durationMono > 0 ? Math.max(40, durationMono / 500) : 40;
  const compacted: number[] = [];

  for (const mono of sorted) {
    const last = compacted[compacted.length - 1];

    if (last === undefined || mono - last >= minGap) {
      compacted.push(mono);
    }
  }

  if (compacted.length <= MAX_PROGRESS_MARKERS_PER_KIND) {
    return compacted;
  }

  const step = Math.ceil(compacted.length / MAX_PROGRESS_MARKERS_PER_KIND);
  return compacted.filter((_, index) => index % step === 0 || index === compacted.length - 1);
}
