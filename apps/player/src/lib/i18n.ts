import type { NetworkCacheSource, PrivacyViolationSubject } from "@webblackbox/player-sdk";

import EN_MESSAGES from "./locales/en.json" with { type: "json" };
import RU_MESSAGES from "./locales/ru.json" with { type: "json" };
import ZH_CN_MESSAGES from "./locales/zh-CN.json" with { type: "json" };
import type { PointerLaneKind } from "./pointer-overlay.js";
import type { StackViewMessages } from "./stack-view.js";
import { readStoredText, writeStoredText } from "./storage.js";

export type PlayerLocale = "en" | "ru" | "zh-CN";

export const PLAYER_LOCALES: readonly PlayerLocale[] = ["en", "ru", "zh-CN"];

type PanelKey =
  | "timeline"
  | "details"
  | "actions"
  | "network"
  | "compare"
  | "console"
  | "realtime"
  | "storage"
  | "perf";

type NetworkType =
  | "document"
  | "fetch"
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "text"
  | "other";

type CompareSignal = "regressed" | "stable" | "new" | "missing";
type MarkerKind = "error" | "network" | "screenshot" | "recording" | "action" | "pointer";
type PointerRippleKind = "double" | "right" | "middle" | "hold" | "drag" | "dnd";
type SortDirection = "asc" | "desc";
type SelectionKind = "action" | "event" | "request";
type SensitiveReason = "redacted-marker" | "hashed-value" | "sensitive-pattern";

/** Decimals are fixed (min = max); `signed` shows "+" on positives, `percent` takes a ratio. */
export type NumberStyle = { fractionDigits?: number; signed?: boolean; percent?: boolean };

const MS_PER_SECOND = 1000;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

type PlayerMessages = {
  pageTitlePlayer: string;
  toolbarTitlePlayer: string;
  toolbarPlayerVersion: string;
  toolbarLoadArchive: string;
  toolbarLoadCompare: string;
  toolbarGitHubRepo: string;
  toolbarLanguage: string;
  localeNames: Record<PlayerLocale, string>;
  modeLite: string;
  modeFull: string;
  unitSeconds: string;
  unitSecondsLabel: string;
  unitMilliseconds: string;
  unitBytes: string;
  unitKilobytes: string;
  unitMegabytes: string;
  statusWindow: string;
  statusCounts: string;
  statusPanelOnly: string;
  statusPanelSelection: string;
  selectionAction: string;
  selectionEvent: string;
  selectionRequest: string;
  quickTriage: string;
  maskResponsePreview: string;
  dismiss: string;
  cancel: string;
  load: string;
  copy: string;
  copied: string;
  close: string;
  preflightErrors: string;
  preflightFailedReqs: string;
  preflightSlowReqs: string;
  preflightScreenshots: string;
  preflightActions: string;
  preflightOpenFullPlayer: string;
  preflightCopyBugReport: string;
  preflightJumpFirstError: string;
  preflightJumpSlowestRequest: string;
  playbackBackStep: string;
  playbackPlay: string;
  playbackPause: string;
  playbackForwardStep: string;
  playbackSpeed: string;
  playbackTime: string;
  previewAltScreenshotPlayback: string;
  previewAltRecordingPlayback: string;
  previewAltProgressPreview: string;
  stagePlaceholderLoadArchive: string;
  progressLegendError: string;
  progressLegendNetwork: string;
  progressLegendScreenshot: string;
  progressLegendRecording: string;
  progressLegendAction: string;
  resizeScreenshotStage: string;
  resizePanels: string;
  filterTimelinePlaceholder: string;
  filterAllTimelineEvents: string;
  filterErrors: string;
  filterNetwork: string;
  filterStorage: string;
  filterConsole: string;
  scopeFilterAll: string;
  scopeFilterMain: string;
  scopeFilterIframe: string;
  exportBugReport: string;
  exportHar: string;
  exportPlaywright: string;
  exportPlaywrightMocks: string;
  exportGitHub: string;
  exportJira: string;
  share: string;
  loadShared: string;
  panelTabsLabel: string;
  eventHeading: string;
  eventDetailsHeading: string;
  actionTimelineHeading: string;
  networkHeading: string;
  compareHeading: string;
  consoleHeading: string;
  realtimeHeading: string;
  storageHeading: string;
  performanceHeading: string;
  networkFiltersLabel: string;
  networkFilterPlaceholder: string;
  networkAllMethods: string;
  networkAllStatus: string;
  networkStatusFailed: string;
  networkAllTypes: string;
  networkColumnName: string;
  networkColumnMethod: string;
  networkColumnStatus: string;
  networkColumnType: string;
  networkColumnInitiator: string;
  networkColumnSize: string;
  networkColumnTime: string;
  networkColumnWaterfall: string;
  copyCurl: string;
  copyFetch: string;
  replayRequest: string;
  consoleFilterPlaceholder: string;
  shareArchiveTitle: string;
  shareArchiveDescription: string;
  shareServerUrl: string;
  shareOptionalApiKey: string;
  sharePlaceholderServerUrl: string;
  sharePlaceholderApiKeyRequired: string;
  sharePrivacyPreflightTitle: string;
  sharePrivacyPreflightDescription: string;
  sharePrivacyRedactionProfile: string;
  sharePrivacyDetectedSignals: string;
  sharePrivacySensitivePreview: string;
  sharePrivacyReviewed: string;
  sharePrivacyProfileSummary: string;
  sharePrivacyDetectedSummary: string;
  sharePrivacyPreviewSummary: string;
  sharePrivacyPreviewEmpty: string;
  sharePrivacyPreviewSample: string;
  loadSharedArchiveTitle: string;
  loadSharedArchiveDescription: string;
  loadSharedArchiveUntrustedOrigin: string;
  shareReference: string;
  shareReferencePlaceholder: string;
  encryptedArchiveTitle: string;
  encryptedArchiveDescription: string;
  passphrase: string;
  passphrasePlaceholder: string;
  playwrightPreviewTitle: string;
  playwrightPreviewDescription: string;
  playwrightRangeStart: string;
  playwrightRangeEnd: string;
  playwrightMaxActions: string;
  playwrightIncludeHarReplay: string;
  regenerate: string;
  download: string;
  dropArchiveToLoad: string;
  dropArchiveSupport: string;
  responseExpandJson: string;
  responseCollapseJson: string;
  responseNoBodyCaptured: string;
  responseUnavailable: string;
  responseCopyFailed: string;
  responseCopied: string;
  responsePreviewEmptyBody: string;
  responsePreviewBinary: string;
  noEventAtTime: string;
  progressMarkerLabel: string;
  progressSummary: string;
  jumpNoErrorEvents: string;
  jumpedFirstError: string;
  jumpNoNetworkRequests: string;
  jumpedSlowestRequest: string;
  summaryEmptyLoadArchive: string;
  compareDetailsEmpty: string;
  summaryLabelTriage: string;
  summaryPillErrors: string;
  summaryPillFailedRequests: string;
  summaryPillSlowRequests: string;
  summaryCompareEventDelta: string;
  summaryMode: string;
  summaryOrigin: string;
  summaryPlayhead: string;
  summaryVisibleEvents: string;
  summaryMainEvents: string;
  summaryIframeEvents: string;
  summaryVisibleErrors: string;
  summaryVisibleRequests: string;
  summaryMainRequests: string;
  summaryIframeRequests: string;
  summaryVisibleActions: string;
  summaryVisibleScreenshots: string;
  summaryAllActions: string;
  compareNoArchiveLoaded: string;
  compareNoEndpointDeltas: string;
  compareHeadingTimelineAB: string;
  compareHeadingWaterfallAlignment: string;
  compareHeadingEndpointRegressions: string;
  compareColumnEndpoint: string;
  compareColumnCountDelta: string;
  compareColumnFailRateDelta: string;
  compareColumnP95Delta: string;
  compareColumnSessionA: string;
  compareColumnSessionB: string;
  compareColumnSignal: string;
  compareEndpointSummary: string;
  compareSummaryTitle: string;
  compareSummaryLeft: string;
  compareSummaryRight: string;
  compareSummaryTotals: string;
  compareSummaryEvents: string;
  compareSummaryErrors: string;
  compareSummaryRequests: string;
  compareSummaryDuration: string;
  compareSummaryTopTypes: string;
  compareSummaryTypeDelta: string;
  compareSummaryEndpoint: string;
  timelineEmpty: string;
  actionsEmpty: string;
  eventDetailsEmpty: string;
  eventDetailsOutOfRange: string;
  actionDetailsEmpty: string;
  actionDetailsOutOfRange: string;
  actionMetricDuration: string;
  actionMetricEvents: string;
  actionMetricRequests: string;
  actionMetricErrors: string;
  actionMetricShot: string;
  actionMetricNoShot: string;
  actionSectionNetwork: string;
  actionSectionErrors: string;
  actionSectionReplay: string;
  replayDiagnosticSummary: string;
  replayConfidenceHigh: string;
  replayConfidenceMedium: string;
  replayConfidenceLow: string;
  replayCauseChainEmpty: string;
  sortColumnFallback: string;
  sortByColumn: string;
  sortedByColumn: string;
  requestDetailsEmpty: string;
  requestNoneSelected: string;
  requestWindowEmpty: string;
  requestFilterEmpty: string;
  networkScopeSummary: string;
  networkSummaryEmpty: string;
  networkSummary: string;
  networkSummaryTruncated: string;
  scopeTagMain: string;
  scopeTagIframe: string;
  scopeSummaryMain: string;
  scopeSummaryIframe: string;
  realtimeNoPayload: string;
  realtimePayloadLoading: string;
  realtimePayloadTruncated: string;
  realtimePayloadRecord: string;
  realtimePayloadLoadFailed: string;
  noScreenshotEvents: string;
  screenshotBeforePlayhead: string;
  screenshotLoading: string;
  screenshotDecodeFailed: string;
  screenshotMissingBlob: string;
  screenshotNoLoaded: string;
  screenRecordingLoading: string;
  screenRecordingDecodeFailed: string;
  screenRecordingMissingBlob: string;
  screenRecordingMeta: string;
  feedbackBugReportExported: string;
  feedbackHarExported: string;
  feedbackGitHubIssueExported: string;
  feedbackJiraIssueExported: string;
  feedbackQuickTriageDismissed: string;
  feedbackNoSupportedArchive: string;
  feedbackArchiveLoaded: string;
  feedbackArchiveLoadedWithoutPlayback: string;
  feedbackArchiveLoadFailed: string;
  feedbackCompareLoaded: string;
  feedbackCompareLoadFailed: string;
  feedbackBugReportCopied: string;
  feedbackLoadArchiveBeforePlaywright: string;
  feedbackPlaywrightPreviewCopied: string;
  feedbackPlaywrightScriptExported: string;
  feedbackPlaywrightMocksExported: string;
  feedbackLoadArchiveBeforeSharing: string;
  feedbackInvalidShareServerUrl: string;
  feedbackShareUploadProgress: string;
  feedbackShareMissingUrl: string;
  feedbackShareSucceeded: string;
  feedbackShareFailed: string;
  feedbackInvalidShareReference: string;
  feedbackSharedArchiveLoaded: string;
  feedbackSharedArchiveLoadFailed: string;
  feedbackSharedArchiveLoadingFromUrl: string;
  feedbackCopyCurl: string;
  feedbackCopyFetch: string;
  feedbackReplayStatusDelta: string;
  feedbackReplaySucceeded: string;
  feedbackReplayFailed: string;
  encryptedArchivePassphraseRequired: string;
  encryptedArchivePrompt: string;
  uploadNetworkError: string;
  uploadAborted: string;
  uploadResponseNotJsonObject: string;
  uploadInvalidJson: string;
  screenshotTrailPoints: string;
  screenshotNoTrailPoints: string;
  screenshotNoPointerMarker: string;
  screenshotPointerMarker: string;
  pointerReasonActionClick: string;
  pointerReasonMove: string;
  networkInitiatorDirect: string;
  networkInitiatorActionNumber: string;
  networkStatusPending: string;
  networkStatusPendingPlain: string;
  networkStatusFromCache: string;
  networkStatusFromCachePlain: string;
  networkStatusNoResponse: string;
  networkStatusNoResponsePlain: string;
  networkCacheSources: Record<NetworkCacheSource, string>;
  networkSizeFailed: string;
  actionTriggerUnknown: string;
  pointerLaneLabel: string;
  pointerKinds: Record<PointerLaneKind, string>;
  pointerRippleLabels: Record<PointerRippleKind, string>;
  markerKinds: Record<MarkerKind, string>;
  stackView: StackViewMessages;
  networkTypes: Record<NetworkType, string>;
  privacyHiddenByProfile: string;
  privacySubjects: Record<PrivacyViolationSubject, string>;
  sensitiveReasons: Record<SensitiveReason, string>;
  summaryProfile: string;
  summaryProfileRule: string;
  summaryProfileDowngraded: string;
  profileBannerCancelRuleChanged: string;
  profileBannerCancelMissing: string;
  profileBannerCancelEdited: string;
  profileBannerCancelPolicy: string;
  profileBannerCancelUnknown: string;
  profileBannerDowngraded: string;
  profileBannerCapped: string;
  profileBannerUnknownProfile: string;
  compareSignals: Record<CompareSignal, string>;
  panels: Record<PanelKey, string>;
  sortDirections: Record<SortDirection, string>;
};

export const PLAYER_LOCALE_STORAGE_KEY = "webblackbox.player.locale";

/** English is the reference dictionary; `locales.test.ts` keeps every other locale's keys equal. */
const PLAYER_MESSAGES: Record<PlayerLocale, PlayerMessages> = {
  en: EN_MESSAGES,
  ru: RU_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES
};

const numberFormats = new Map<string, Intl.NumberFormat>();

function getNumberFormat(locale: PlayerLocale, style: NumberStyle): Intl.NumberFormat {
  const fractionDigits = style.fractionDigits ?? 0;
  const cacheKey = [locale, fractionDigits, style.signed === true, style.percent === true].join(
    "|"
  );
  let format = numberFormats.get(cacheKey);

  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: style.percent ? "percent" : "decimal",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      signDisplay: style.signed ? "exceptZero" : "auto"
    });
    numberFormats.set(cacheKey, format);
  }

  return format;
}

function interpolate(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    return value === undefined ? "" : String(value);
  });
}

export function resolvePlayerLocale(raw: string | null | undefined): PlayerLocale {
  const normalized = raw?.trim().toLowerCase().replace(/_/g, "-");

  if (!normalized) {
    return "en";
  }

  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-")
  ) {
    return "zh-CN";
  }

  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru";
  }

  return "en";
}

export function detectPlayerLocale(): PlayerLocale {
  try {
    const parsed = new URL(window.location.href);
    const queryLocale = parsed.searchParams.get("lang") ?? parsed.searchParams.get("locale");

    if (queryLocale) {
      return resolvePlayerLocale(queryLocale);
    }
  } catch {
    // Ignore invalid URLs in test contexts.
  }

  const stored = readStoredText(PLAYER_LOCALE_STORAGE_KEY);

  if (stored) {
    return resolvePlayerLocale(stored);
  }

  const preferred =
    typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language) : "en";
  return resolvePlayerLocale(preferred);
}

export function storePlayerLocale(locale: PlayerLocale): void {
  writeStoredText(PLAYER_LOCALE_STORAGE_KEY, locale);
}

export function createPlayerI18n(locale: PlayerLocale = "en") {
  const messages = PLAYER_MESSAGES[locale];

  const t = <K extends keyof PlayerMessages>(
    key: K,
    values?: Record<string, string | number>
  ): string => {
    const value = messages[key];
    return typeof value === "string" ? interpolate(value, values) : "";
  };

  const formatNumber = (value: number, style: NumberStyle = {}): string =>
    getNumberFormat(locale, style).format(Number.isFinite(value) ? value : 0);
  /** Playback clock style: seconds with two decimals ("1.25s", "1,25 с"). */
  const formatSeconds = (ms: number, style: NumberStyle = {}): string =>
    t("unitSeconds", {
      value: formatNumber(ms / MS_PER_SECOND, { fractionDigits: 2, ...style })
    });
  const formatMilliseconds = (ms: number, style: NumberStyle = {}): string =>
    t("unitMilliseconds", { value: formatNumber(ms, style) });
  const formatByteSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < BYTES_PER_KB) {
      return t("unitBytes", {
        value: formatNumber(Number.isFinite(bytes) ? Math.round(bytes) : 0)
      });
    }

    if (bytes < BYTES_PER_MB) {
      return t("unitKilobytes", {
        value: formatNumber(bytes / BYTES_PER_KB, { fractionDigits: 1 })
      });
    }

    return t("unitMegabytes", { value: formatNumber(bytes / BYTES_PER_MB, { fractionDigits: 2 }) });
  };
  /** Known privacy-scanner reasons are translated; anything else is shown as words. */
  const formatSensitiveReason = (reason: string): string =>
    Object.hasOwn(messages.sensitiveReasons, reason)
      ? messages.sensitiveReasons[reason as SensitiveReason]
      : reason.replaceAll("-", " ");

  const formatMode = (mode: string): string => {
    if (mode === "lite") {
      return messages.modeLite;
    }

    if (mode === "full") {
      return messages.modeFull;
    }

    return mode.toUpperCase();
  };

  const formatPanelLabel = (panel: PanelKey): string => messages.panels[panel];
  const formatScopeTag = (scope: "main" | "iframe"): string =>
    scope === "iframe" ? messages.scopeTagIframe : messages.scopeTagMain;
  const formatMarkerKind = (kind: MarkerKind): string => messages.markerKinds[kind];
  const formatPointerKind = (kind: PointerLaneKind): string => messages.pointerKinds[kind];
  const formatPointerRipple = (kind: string): string | null =>
    kind in messages.pointerRippleLabels
      ? messages.pointerRippleLabels[kind as PointerRippleKind]
      : null;
  const formatNetworkType = (type: NetworkType): string => messages.networkTypes[type];
  const formatHiddenByProfile = (subject: PrivacyViolationSubject): string =>
    t("privacyHiddenByProfile", { what: messages.privacySubjects[subject] });
  const formatCompareSignal = (signal: CompareSignal): string => messages.compareSignals[signal];
  const formatSortDirection = (direction: SortDirection): string =>
    messages.sortDirections[direction];
  const selectionKeys = {
    action: "selectionAction",
    event: "selectionEvent",
    request: "selectionRequest"
  } as const satisfies Record<SelectionKind, keyof PlayerMessages>;
  const formatSelection = (kind: SelectionKind, id: string): string =>
    t(selectionKeys[kind], { id });

  const formatStatusCounts = (events: number, errors: number, requests: number): string =>
    t("statusCounts", {
      events: formatNumber(events),
      errors: formatNumber(errors),
      requests: formatNumber(requests)
    });
  const formatStatusPanel = (panel: PanelKey, selection?: string): string =>
    selection
      ? t("statusPanelSelection", { panel: formatPanelLabel(panel), selection })
      : t("statusPanelOnly", { panel: formatPanelLabel(panel) });
  const formatScopeSummary = (mainCount: number, iframeCount: number): string =>
    t("networkScopeSummary", {
      mainLabel: messages.scopeSummaryMain,
      mainCount,
      iframeLabel: messages.scopeSummaryIframe,
      iframeCount
    });
  const formatNetworkSummary = (
    filteredCount: number,
    totalCount: number,
    filteredBytes: string,
    totalBytes: string,
    renderedCount?: number
  ): string => {
    if (filteredCount <= 0 && totalCount <= 0) {
      return messages.networkSummaryEmpty;
    }

    const base = t("networkSummary", {
      filteredCount,
      totalCount,
      filteredBytes,
      totalBytes
    });

    if (typeof renderedCount !== "number" || renderedCount >= filteredCount || filteredCount <= 0) {
      return base;
    }

    return `${base}${t("networkSummaryTruncated", {
      renderedCount,
      filteredCount,
      hiddenCount: Math.max(0, filteredCount - renderedCount)
    })}`;
  };
  const formatProgressSummary = (options: {
    markerKind?: MarkerKind;
    eventText: string;
    eventCount: number;
    networkCount: number;
    errorCount: number;
  }): string => {
    const markerPrefix = options.markerKind
      ? `${t("progressMarkerLabel", { kind: formatMarkerKind(options.markerKind) })} | `
      : "";

    return t("progressSummary", {
      markerPrefix,
      eventText: options.eventText,
      eventCount: options.eventCount,
      networkCount: options.networkCount,
      errorCount: options.errorCount
    });
  };
  const formatActionMetrics = (options: {
    durationMs: number;
    eventCount: number;
    requestCount: number;
    errorCount: number;
    screenshotMeta: string;
  }): string[] => [
    t("actionMetricDuration", { value: formatNumber(options.durationMs, { fractionDigits: 1 }) }),
    t("actionMetricEvents", { count: options.eventCount }),
    t("actionMetricRequests", { count: options.requestCount }),
    t("actionMetricErrors", { count: options.errorCount }),
    options.screenshotMeta
  ];
  const formatCompareEndpointSummary = (count: number, failRate: number, p95Ms: number): string =>
    t("compareEndpointSummary", {
      count: formatNumber(count),
      failRate: formatNumber(failRate),
      p95Ms: formatNumber(p95Ms)
    });
  const formatPassphrasePrompt = (fileName: string): string =>
    t("encryptedArchivePrompt", { fileName });
  const formatShareUploadProgress = (
    percent: string,
    loadedBytes: string,
    totalBytes: string
  ): string => t("feedbackShareUploadProgress", { percent, loadedBytes, totalBytes });
  const formatBinaryResponsePreview = (mime: string, bytes: number): string =>
    t("responsePreviewBinary", { mime, bytes: formatByteSize(bytes) });
  const formatNetworkInitiatorActionNumber = (index: string): string =>
    t("networkInitiatorActionNumber", { index });

  return {
    locale,
    messages,
    t,
    formatMode,
    formatPanelLabel,
    formatScopeTag,
    formatMarkerKind,
    formatPointerKind,
    formatPointerRipple,
    formatNetworkType,
    formatHiddenByProfile,
    formatCompareSignal,
    formatSortDirection,
    formatSelection,
    formatStatusCounts,
    formatStatusPanel,
    formatScopeSummary,
    formatNetworkSummary,
    formatProgressSummary,
    formatActionMetrics,
    formatCompareEndpointSummary,
    formatPassphrasePrompt,
    formatShareUploadProgress,
    formatBinaryResponsePreview,
    formatNetworkInitiatorActionNumber,
    formatNumber,
    formatSeconds,
    formatMilliseconds,
    formatByteSize,
    formatSensitiveReason
  };
}

export function applyPlayerDocumentLocale(locale: PlayerLocale): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = locale;
  document.title = createPlayerI18n(locale).messages.pageTitlePlayer;
}
