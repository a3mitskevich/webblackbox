import type {
  BODY_SKIP_REASONS,
  CAPTURE_MODES,
  CHUNK_CODECS,
  EVENT_LEVELS,
  FREEZE_REASONS,
  MESSAGE_TYPES,
  STORAGE_SNAPSHOT_MODES,
  WEBBLACKBOX_EVENT_TYPES
} from "./constants.js";
import type { PointerCaptureOptions } from "./pointer.js";

export type EventLevel = (typeof EVENT_LEVELS)[number];

export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type ChunkCodec = (typeof CHUNK_CODECS)[number];

export type WebBlackboxEventType = (typeof WEBBLACKBOX_EVENT_TYPES)[number];

export type MessageType = (typeof MESSAGE_TYPES)[number];

export type FreezeReason = (typeof FREEZE_REASONS)[number];

export type StorageSnapshotMode = (typeof STORAGE_SNAPSHOT_MODES)[number];

export type BodySkipReason = (typeof BODY_SKIP_REASONS)[number];

/** Payload of `network.body.skipped`. */
export type NetworkBodySkippedPayload = {
  reqId: string;
  side: "request" | "response";
  reason: BodySkipReason;
  mimeType?: string;
  /** Body size in bytes when the browser reported it. */
  size?: number;
  /** The limit that was hit (bytes for `too-large`, bodies for `session-limit`). */
  limit?: number;
  /** Short browser error text for `not-retained` / `fetch-failed`. */
  detail?: string;
};

export type EventReference = {
  act?: string;
  req?: string;
  mut?: string;
  shot?: string;
  err?: string;
  task?: string;
  prev?: string;
};

export type PrivacyDataCategory =
  | "actions"
  | "inputs"
  | "dom"
  | "screenshots"
  | "screenRecordings"
  | "console"
  | "network"
  | "storage"
  | "performance"
  | "system";

export type PrivacySensitivity = "low" | "medium" | "high";

export type PrivacyClassification = {
  category: PrivacyDataCategory;
  sensitivity: PrivacySensitivity;
  redacted: boolean;
};

export type WebBlackboxEvent<TData = unknown> = {
  v: 1;
  sid: string;
  tab: number;
  nav?: string;
  frame?: string;
  tgt?: string;
  cdp?: string;
  t: number;
  mono: number;
  dt?: number;
  type: WebBlackboxEventType;
  id: string;
  lvl?: EventLevel;
  ref?: EventReference;
  privacy?: PrivacyClassification;
  data: TData;
};

export type TimeWindow = {
  t0: number;
  t1: number;
};

export type SamplingProfile = {
  mousemoveHz: number;
  scrollHz: number;
  domFlushMs: number;
  screenshotIdleMs: number;
  snapshotIntervalMs: number;
  actionWindowMs: number;
  bodyCaptureMaxBytes: number;
};

/** Where a user value pattern is applied. */
export type RedactionTarget = "bodies" | "dom" | "storage" | "inputs" | "console" | "urls";

/** A user regex (linear-time engine, case-insensitive) masked wherever its targets are recorded. */
export type RedactionValuePattern = {
  pattern: string;
  targets: RedactionTarget[];
};

/**
 * What is masked inside captured content. Masking applies the user's rules on a best-effort
 * basis and does not guarantee that all sensitive data is removed; what is captured at all is
 * decided by the capture policy categories, and archives are always encrypted.
 */
export type RedactionProfile = {
  /**
   * Master switch (default true). `false` records captured content as-is wherever the categories
   * allow it: no masking, hashing, URL stripping or DOM sanitizing.
   */
  contentRedaction?: boolean;
  /**
   * The built-in heuristic rule set (default true): URL query stripping and path templating,
   * secret detection by name and shape, and the fail-closed raw DOM sanitizer.
   */
  builtInHeuristics?: boolean;
  /** URL query parameter names whose values are masked (case-insensitive). */
  redactQueryParams?: string[];
  /** Storage key parts whose values are masked (case-insensitive substring). */
  redactStorageKeys?: string[];
  /** User regexes masked in the listed targets. */
  valuePatterns?: RedactionValuePattern[];
  redactHeaders: string[];
  redactCookieNames: string[];
  redactBodyPatterns: string[];
  blockedSelectors: string[];
  hashSensitiveValues: boolean;
  /**
   * Selectors explicitly allowed to stay readable even when they also match `blockedSelectors`.
   * Password inputs are never unmasked.
   */
  unmaskSelectors?: string[];
};

export type CaptureContext = "real-user" | "synthetic" | "local-debug";

export type CaptureConsent = {
  id: string;
  provenance: "self-recording" | "support-assisted" | "enterprise-admin-policy";
  purpose: "debugging" | "support" | "qa" | "incident-response" | "other";
  grantedBy?: string;
  grantedAt: string;
  expiresAt?: string;
  revocationRef?: string;
};

export type CaptureScope = {
  tabId: number;
  origin: string;
  allowedOrigins: string[];
  deniedOrigins: string[];
  includeSubframes: boolean;
  stopOnOriginChange: boolean;
  excludedUrlPatterns: string[];
};

export type CapturePolicy = {
  schemaVersion: 2;
  mode: "private" | "debug" | "lab";
  captureContext: CaptureContext;
  captureContextEvidenceRef?: string;
  consent: CaptureConsent;
  unmaskPolicySource: "none" | "extension-managed" | "enterprise" | "signed-site-owner";
  scope: CaptureScope;
  categories: {
    actions: "metadata" | "masked" | "allow";
    inputs: "none" | "length-only" | "masked" | "allow";
    dom: "off" | "wireframe" | "masked" | "allow";
    screenshots: "off" | "masked" | "allow";
    screenRecordings: "off" | "allow";
    console: "off" | "metadata" | "sanitized" | "allow";
    network: "metadata" | "headers-allowlist" | "body-allowlist";
    storage: "off" | "counts-only" | "names-only" | "lengths-only" | "allow";
    indexedDb: "off" | "counts-only" | "names-only" | "allow";
    cookies: "off" | "count-only" | "names-only" | "allow";
    cdp: "off" | "safe-subset" | "full";
    heapProfiles: "off" | "lab-only";
  };
  redaction: RedactionProfile;
  encryption: {
    localAtRest: "required";
    archive: "required" | "synthetic-local-debug-exempt" | "explicit-low-risk-override";
    archiveKeyEnvelope: "passphrase" | "enterprise-managed" | "client-side-share-fragment" | "none";
    overrideReasonRef?: string;
  };
  retention: {
    localTtlMs: number;
    shareTtlMs?: number;
  };
};

export type SiteCapturePolicy = {
  originPattern: string;
  mode: CaptureMode;
  enabled: boolean;
  allowBodyCapture: boolean;
  bodyMimeAllowlist: string[];
  pathAllowlist: string[];
  pathDenylist: string[];
};

export type RecorderConfig = {
  mode: CaptureMode;
  ringBufferMinutes: number;
  freezeOnError: boolean;
  freezeOnNetworkFailure: boolean;
  freezeOnLongTaskSpike: boolean;
  sampling: SamplingProfile;
  redaction: RedactionProfile;
  capturePolicy?: CapturePolicy;
  sitePolicies: SiteCapturePolicy[];
  /** Optional pointer streams; absent = all off. */
  pointer?: PointerCaptureOptions;
};

export type SessionMetadata = {
  sid: string;
  tabId: number;
  windowId?: number;
  startedAt: number;
  endedAt?: number;
  mode: CaptureMode;
  url: string;
  title?: string;
  tags: string[];
};

export type ChunkTimeIndexEntry = {
  chunkId: string;
  seq: number;
  tStart: number;
  tEnd: number;
  monoStart: number;
  monoEnd: number;
  eventCount: number;
  byteLength: number;
  codec: ChunkCodec;
  sha256: string;
};

export type RequestIndexEntry = {
  reqId: string;
  eventIds: string[];
};

export type InvertedIndexEntry = {
  term: string;
  eventIds: string[];
};

export type HashesManifest = {
  manifestSha256: string;
  files: Record<string, string>;
};

export type ExportStats = {
  eventCount: number;
  chunkCount: number;
  blobCount: number;
  durationMs: number;
};

export type ExportEncryption = {
  algorithm: "AES-GCM";
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    saltBase64: string;
  };
  files: Record<
    string,
    {
      ivBase64: string;
    }
  >;
};

export type PrivacyScannerFindingKind =
  | "jwt"
  | "bearer-token"
  | "api-key"
  | "oauth-code"
  | "session-cookie"
  | "email"
  | "phone"
  | "credit-card"
  | "ssn"
  | "private-key"
  | "long-secret";

export type PrivacyScannerFinding = {
  kind: PrivacyScannerFindingKind;
  severity: "high";
  path: string;
  matchCount: number;
  sampleSha256: string;
};

export type PrivacyScannerResult = {
  scannedAt: string;
  preEncryption: boolean;
  status: "passed" | "blocked";
  findings: PrivacyScannerFinding[];
};

export type PrivacyManifestCategorySummary = {
  category: PrivacyDataCategory;
  events: number;
  low: number;
  medium: number;
  high: number;
  redacted: number;
  unredacted: number;
};

export type PrivacyManifest = {
  schemaVersion: 1;
  generatedAt: string;
  effectivePolicy?: CapturePolicy;
  consent?: CaptureConsent;
  transfer?: {
    destination: "local-download" | "public-cloud-share" | "support-upload" | "enterprise-upload";
    archiveKeyEnvelope: CapturePolicy["encryption"]["archiveKeyEnvelope"];
    encrypted: boolean;
    includeScreenshots: boolean;
    includeScreenRecordings: boolean;
    maxArchiveBytes: number | null;
    recentWindowMs: number | null;
    shareEligible: boolean;
    computedAt: string;
  };
  categories: PrivacyManifestCategorySummary[];
  scanner: PrivacyScannerResult;
  encryption: {
    archive: "encrypted" | "plaintext";
    algorithm?: ExportEncryption["algorithm"];
  };
  totals: {
    events: number;
    blobs: number;
    privacyViolations: number;
  };
};

/**
 * The full archive manifest. Format 1 archives store it as plaintext `manifest.json`; format 2
 * archives encrypt it (`meta/manifest.json`) and readers merge it with the envelope.
 */
export type ExportManifest = {
  protocolVersion: 1 | 2;
  createdAt: string;
  mode: CaptureMode;
  site: {
    origin: string;
    title?: string;
  };
  chunkCodec: ChunkCodec;
  redactionProfile: RedactionProfile;
  stats: ExportStats;
  encryption?: ExportEncryption;
};

/** Plaintext `manifest.json` of a format 2 archive: only what decryption needs. */
export type ArchiveEnvelopeManifest = {
  protocolVersion: 2;
  encryption: ExportEncryption;
};

export type SessionStartMessage = {
  t: "CTRL.START_SESSION";
  sid: string;
  tabId: number;
  mode: CaptureMode;
  config: RecorderConfig;
};

export type SessionStopMessage = {
  t: "CTRL.STOP_SESSION";
  sid: string;
  tabId: number;
  reason?: string;
};

export type FreezeMessage = {
  t: "CTRL.FREEZE";
  sid: string;
  tabId: number;
  why: FreezeReason;
};

export type ExportMessage = {
  t: "CTRL.EXPORT";
  sid: string;
  passphrase?: string;
};

export type ExportPolicy = {
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number;
  recentWindowMs: number;
};

export type EventBatchMessage = {
  t: "EVT.BATCH";
  sid: string;
  tabId: number;
  seq: number;
  events: WebBlackboxEvent[];
};

export type BlobPutMessage = {
  t: "PIPE.BLOB_PUT";
  sid: string;
  hash: string;
  mime: string;
  bytes: ArrayBuffer;
};

export type ChunkPutMessage = {
  t: "PIPE.CHUNK_PUT";
  sid: string;
  chunkId: string;
  tStart: number;
  tEnd: number;
  codec: ChunkCodec;
  bytes: ArrayBuffer;
  sha256: string;
};

export type BuildIndexMessage = {
  t: "PIPE.BUILD_INDEX";
  sid: string;
};

export type ExportDoneMessage = {
  t: "PIPE.EXPORT_DONE";
  sid: string;
  size: number;
  fileName?: string;
};

export type WebBlackboxMessage =
  | SessionStartMessage
  | SessionStopMessage
  | FreezeMessage
  | ExportMessage
  | EventBatchMessage
  | BlobPutMessage
  | ChunkPutMessage
  | BuildIndexMessage
  | ExportDoneMessage;

export type NetworkBodyCaptureRule = {
  enabled: boolean;
  mimeAllowlist: string[];
  maxBytes: number;
};
