import type {
  CaptureMode,
  CapturePolicy,
  ExportPolicy,
  FreezeReason,
  PrivacyScannerFindingKind,
  SamplingProfile
} from "@webblackbox/protocol";

import type { RawRecorderEvent } from "@webblackbox/recorder";

export const PORT_NAMES = {
  content: "webblackbox:content",
  popup: "webblackbox:popup",
  options: "webblackbox:options",
  sessions: "webblackbox:sessions",
  offscreen: "webblackbox:offscreen"
} as const;

export type FullModeVisualCapture = "screenshots" | "recording" | "both" | "none";

export type UiStartSessionMessage = {
  kind: "ui.start";
  tabId?: number;
  mode: CaptureMode;
  reloadPage?: boolean;
  visualCapture?: FullModeVisualCapture;
  /**
   * Backward-compatible alias for older popup/runtime callers. New callers
   * should send `visualCapture` so screenshots can be disabled for
   * recording-only full sessions.
   */
  recordScreen?: boolean;
  /** Recording profile id, or `"auto"` / absent to let site rules pick one. */
  profileId?: string;
};

export type UiStopSessionMessage = {
  kind: "ui.stop";
  tabId?: number;
};

export type UiExportSessionMessage = {
  kind: "ui.export";
  sid: string;
  /** Required: every archive is encrypted (at least 8 characters, trimmed). */
  passphrase?: string;
  saveAs?: boolean;
  policy?: Partial<ExportPolicy>;
};

export type UiDeleteSessionMessage = {
  kind: "ui.delete";
  sid: string;
};

export type UiAnnotateSessionMessage = {
  kind: "ui.annotate";
  sid: string;
  tags?: string[];
  note?: string;
};

export type UiRequestSessionListMessage = {
  kind: "ui.request-session-list";
};

/** Popup asks which profile would record the tab and what profiles exist. */
export type UiResolveProfileMessage = {
  kind: "ui.resolve-profile";
  tabId?: number;
  profileId?: string;
};

/** Popup has shown a "recording stopped: profile changed" notice; the badge can go back. */
export type UiAckProfileCancelMessage = {
  kind: "ui.ack-profile-cancel";
  sid: string;
};

export type ContentEventBatchMessage = {
  kind: "content.events";
  events: RawRecorderEvent[];
};

export type ContentMarkerMessage = {
  kind: "content.marker";
  message: string;
};

export type ContentReadyMessage = {
  kind: "content.ready";
};

export type ContentStopDrainedMessage = {
  kind: "content.stop-drained";
  sid: string;
};

export type ExtensionInboundMessage =
  | UiStartSessionMessage
  | UiStopSessionMessage
  | UiExportSessionMessage
  | UiDeleteSessionMessage
  | UiAnnotateSessionMessage
  | UiRequestSessionListMessage
  | UiAckProfileCancelMessage
  | UiResolveProfileMessage
  | ContentEventBatchMessage
  | ContentMarkerMessage
  | ContentReadyMessage
  | ContentStopDrainedMessage;

export type RecordingStatusMessage = {
  kind: "sw.recording-status";
  active: boolean;
  sid?: string;
  mode?: CaptureMode;
  sampling?: Pick<
    SamplingProfile,
    | "mousemoveHz"
    | "scrollHz"
    | "domFlushMs"
    | "snapshotIntervalMs"
    | "screenshotIdleMs"
    | "bodyCaptureMaxBytes"
  >;
  capturePolicy?: CapturePolicy;
  /** Per-session nonce the injected page hooks stamp on bridge messages (lite mode). */
  injectedBridgeNonce?: string;
};

export type FreezeNoticeMessage = {
  kind: "sw.freeze";
  sid: string;
  reason: FreezeReason;
};

export type SessionListItem = {
  sid: string;
  tabId: number;
  mode: CaptureMode;
  startedAt: number;
  active: boolean;
  stoppedAt?: number;
  url?: string;
  title?: string;
  ringBufferMinutes?: number;
  eventCount?: number;
  errorCount?: number;
  budgetAlertCount?: number;
  sizeBytes?: number;
  tags?: string[];
  note?: string;
  /** Name of the recording profile the session records with. */
  profileName?: string;
  /** Set when the session was stopped because its recording profile changed. */
  profileCancel?: ProfileCancelNotice;
};

/** Anchor of the profiles section of `options.html`; the popup links to it. */
export const PROFILES_SECTION_ID = "profiles";

/** Why a recording was stopped after its effective profile changed. */
export type ProfileCancelReason =
  | "rule-changed"
  | "profile-missing"
  | "profile-edited"
  | "enterprise-policy";

/** What the popup needs to explain a cancelled recording and how to fix it. */
export type ProfileCancelNotice = {
  reason: ProfileCancelReason;
  at: number;
  startedName: string;
  nextName?: string;
};

export type SessionListMessage = {
  kind: "sw.session-list";
  sessions: SessionListItem[];
};

export type ExportStatusMessage = {
  kind: "sw.export-status";
  sid: string;
  ok: boolean;
  fileName?: string;
  error?: string;
  privacyWarning?: ExportPrivacyWarning;
};

/** One selectable profile as the popup shows it. */
export type ProfileCatalogEntry = {
  id: string;
  name: string;
  base: CaptureMode;
  extended: boolean;
  readOnly: boolean;
};

export type ProfilePreviewResponse = {
  kind: "sw.profile-preview";
  catalog: ProfileCatalogEntry[];
  /** Profile that Start would use for the tab with the requested choice. */
  selection: {
    id: string;
    name: string;
    base: CaptureMode;
    source: "explicit" | "rule" | "default";
    ruleName?: string;
    extended: boolean;
    /** Visual capture the profile pins; absent = the popup's choice applies. */
    visual?: FullModeVisualCapture;
    /** Categories the enterprise policy caps below what the profile asks for. */
    enterpriseCapped?: string[];
  } | null;
};

export type ExportPrivacyWarning = {
  findingCount: number;
  summary: string;
  findings: Array<{
    kind: PrivacyScannerFindingKind;
    path: string;
    matchCount: number;
  }>;
};

export type PipelineStatusMessage = {
  kind: "sw.pipeline-status";
  activeSessions: number;
  sessions: SessionListItem[];
  updatedAt: number;
};

export type ExtensionOutboundMessage =
  | RecordingStatusMessage
  | FreezeNoticeMessage
  | SessionListMessage
  | ExportStatusMessage
  | PipelineStatusMessage
  | ProfilePreviewResponse;
