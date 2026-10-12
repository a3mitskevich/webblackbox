import type {
  CaptureMode,
  CapturePolicy,
  ExportPolicy,
  FreezeReason,
  PointerCaptureOptions,
  PrivacyScannerFindingKind,
  SamplingProfile,
  SessionInterruption
} from "@webblackbox/protocol";

import type { RawRecorderEvent } from "@webblackbox/recorder";

import type { CaptureFallback } from "./capture-fallback.js";

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
  /** Engine to start in; absent = the profile's own (`base`). A profile needing Full gets Full. */
  mode?: CaptureMode;
  reloadPage?: boolean;
  visualCapture?: FullModeVisualCapture;
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

/** "Later" on the export step: the recording stays listed, the prompt and the badge go. */
export type UiDismissExportMessage = {
  kind: "ui.dismiss-export";
  sid: string;
};

/** Whether a passphrase is remembered for this browser session (`sw.passphrase-status`). */
export type UiPassphraseStatusMessage = {
  kind: "ui.passphrase-status";
};

/** Forgets the remembered export passphrase; the next export asks again. */
export type UiForgetPassphraseMessage = {
  kind: "ui.forget-passphrase";
};

/** Popup has shown a "recording stopped: profile changed" notice; the badge can go back. */
export type UiAckProfileCancelMessage = {
  kind: "ui.ack-profile-cancel";
  sid: string;
};

/**
 * A raw event as the content script sends it. The service worker sets the tab (and the frame when
 * the event has none) from the port's sender, never from the event.
 */
export type ContentRawEvent = Pick<
  RawRecorderEvent,
  "rawType" | "sid" | "t" | "mono" | "nav" | "frame" | "payload"
> & {
  source: "content";
};

export type ContentEventBatchMessage = {
  kind: "content.events";
  events: ContentRawEvent[];
};

export type ContentMarkerMessage = {
  kind: "content.marker";
  message: string;
};

export type ContentReadyMessage = {
  kind: "content.ready";
};

/** A recording frame's content script asks for the capture agent (`content-agent.js`). */
export type ContentAgentRequestMessage = {
  kind: "content.agent-request";
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
  | UiDismissExportMessage
  | UiPassphraseStatusMessage
  | UiForgetPassphraseMessage
  | UiResolveProfileMessage
  | ContentEventBatchMessage
  | ContentMarkerMessage
  | ContentReadyMessage
  | ContentAgentRequestMessage
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
  /** Lite pages scan their scripts for source map references. */
  scriptSourceMaps?: boolean;
  /** Per-session nonce the injected page hooks stamp on bridge messages (lite mode). */
  injectedBridgeNonce?: string;
  pointer?: PointerCaptureOptions;
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
  eventCount?: number;
  errorCount?: number;
  budgetAlertCount?: number;
  sizeBytes?: number;
  tags?: string[];
  note?: string;
  /** Id and name of the recording profile the session records with. */
  profileId?: string;
  profileName?: string;
  /** Set when the session was stopped because its recording profile changed. */
  profileCancel?: ProfileCancelNotice;
  /** Set when the recording ended without Stop (its service worker went away). */
  interruption?: SessionInterruption;
  /** Set when Full stopped (or could not start) and the recording went on in Light. */
  captureFallback?: CaptureFallback;
  /** Stopped and not exported: the popup shows its export step until it is exported or put off. */
  exportPrompt?: true;
};

/** Anchor of the profiles section of `options.html`; the popup links to it. */
export const PROFILES_SECTION_ID = "profiles";

/** Why a recording was stopped after its effective profile changed. */
export type ProfileCancelReason =
  "rule-changed" | "profile-missing" | "profile-edited" | "enterprise-policy";

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

export type PassphraseStatusMessage = {
  kind: "sw.passphrase-status";
  /** An export passphrase is remembered until the browser closes. */
  remembered: boolean;
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
    /** The profile records data only the Full engine captures: Start always uses Full. */
    requiresFull: boolean;
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
  | PassphraseStatusMessage
  | ProfilePreviewResponse;
