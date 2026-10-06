import { BODY_REDACTION_TOKEN, maskBodyBytes, maskBodyText } from "@webblackbox/protocol";
import type { RawRecorderEvent } from "@webblackbox/recorder";
import { isPageEventKeptInFullMode } from "webblackbox/capture-scope";
import { decodeScreenshotDataUrl, materializeLiteRawEvent } from "webblackbox/lite-materializer";

import {
  applyBodyUrlFilters,
  DEFAULT_BODY_CAPTURE_MAX_BYTES,
  DEFAULT_BODY_MIME_ALLOWLIST,
  isMimeAllowed,
  normalizeMimeType,
  resolveLiteBodyCaptureRule as resolveLiteBodyCaptureRuleUtil,
  type BodyCaptureRule
} from "./body-capture-utils.js";
import type { SessionRuntime } from "./session-registry.js";

const LITE_SCREENSHOT_MAX_DATA_URL_LENGTH = 12 * 1024 * 1024;
const LITE_SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;
const LITE_DOM_SNAPSHOT_MAX_BYTES = 1_500 * 1024;

const STORAGE_SNAPSHOT_RAW_TYPES = new Set([
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot"
]);

/**
 * Whether a page-side raw event carries a lite artifact (screenshot, DOM snapshot, storage
 * snapshot or network body) that must be materialized into pipeline blobs before ingestion.
 * Lite mode materializes them all; full mode only the ones the profile keeps page-side
 * (storage details, raw DOM), matching the agent's `shouldPageCapture` decision.
 */
export function shouldMaterializeLiteContentEvent(
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
  if (STORAGE_SNAPSHOT_RAW_TYPES.has(rawEvent.rawType)) {
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

/**
 * Replaces the inline artifact payload (data URL, HTML, body text) with a blob reference:
 * bytes go to the session pipeline, the event keeps the blob id and metadata.
 */
export async function materializeLiteContentEvent(
  runtime: SessionRuntime,
  rawEvent: RawRecorderEvent
): Promise<RawRecorderEvent | null> {
  if (rawEvent.rawType === "screenshot") {
    return materializeLiteScreenshot(runtime, rawEvent);
  }

  if (rawEvent.rawType === "snapshot") {
    return materializeLiteDomSnapshot(runtime, rawEvent);
  }

  if (STORAGE_SNAPSHOT_RAW_TYPES.has(rawEvent.rawType)) {
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

/** The lite-mode body capture rule for a URL: profile allowlist, site policies, URL filters. */
export function resolveLiteBodyCaptureRule(
  runtime: SessionRuntime,
  url: string,
  mimeType: string | undefined
): BodyCaptureRule {
  return applyBodyUrlFilters(
    resolveLiteBodyCaptureRuleUtil(runtime.config, url, mimeType, {
      defaultMimeAllowlist: resolveProfileBodyMimeAllowlist(runtime, DEFAULT_BODY_MIME_ALLOWLIST),
      fallbackMaxBytes: DEFAULT_BODY_CAPTURE_MAX_BYTES
    }),
    url,
    runtime.profile.selection.profile.network
  );
}

/** The profile's body MIME allowlist, or the engine's default when the profile sets none. */
export function resolveProfileBodyMimeAllowlist(
  runtime: SessionRuntime,
  engineDefault: readonly string[]
): string[] {
  const profileAllowlist = runtime.profile.selection.profile.network.bodyMimeAllowlist;
  return profileAllowlist.length > 0 ? profileAllowlist : [...engineDefault];
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
    const redaction = maskBodyText(body, rules, BODY_REDACTION_TOKEN);
    redacted = redacted || redaction.redacted;
    bytes = new TextEncoder().encode(redaction.value);
  } else {
    const redaction = maskBodyBytes(decodeBase64(body), rules, {
      mimeType,
      redactionToken: BODY_REDACTION_TOKEN
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
