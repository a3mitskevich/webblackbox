import JSZip from "jszip";
import {
  ArchiveLimitError,
  assertArchiveWithinLimits,
  readZipEntryBytes,
  WebBlackboxPlayer,
  type ArchiveLoadLimits
} from "@webblackbox/player-sdk";

import { asRecord, redactText } from "./text.js";

const AES_GCM_IV_BYTES = 12;

export type ArchiveEnvelopeSummary = {
  encrypted: boolean;
  encryptedPrivatePathsComplete: boolean;
  missingEncryptedPaths: string[];
  encryptedPrivatePathsConfidential: boolean;
  plaintextEncryptedPaths: string[];
  analysisError?: string;
};

export type ShareSummary = {
  schemaVersion: 1;
  source: "client" | "server" | "unavailable";
  analyzed: boolean;
  encrypted: boolean;
  analysisError?: string;
  manifest?: {
    mode: string;
    chunkCodec: string;
    recordedAt: string;
  };
  totals?: {
    events: number;
    blobs?: number;
    privacyViolations?: number;
    errors: number;
    requests: number;
    actions: number;
    durationMs: number;
  };
  topActionTriggers?: Array<{
    triggerType: string;
    count: number;
    errorRate: number;
  }>;
  privacy?: {
    redaction: {
      hashSensitiveValues: boolean;
      headerRuleCount: number;
      cookieRuleCount: number;
      bodyPatternCount: number;
      blockedSelectorCount: number;
    };
    detected: ReturnType<WebBlackboxPlayer["getPrivacyProtectionReport"]>["detected"];
    scanner: ReturnType<WebBlackboxPlayer["getPrivacyProtectionReport"]>["scanner"];
    categories?: Array<{
      category: string;
      events: number;
      low: number;
      medium: number;
      high: number;
      redacted: number;
      unredacted: number;
    }>;
  };
};

/** Result of analyzing one uploaded archive. */
export type ArchiveAnalysis = {
  envelope: ArchiveEnvelopeSummary;
  summary: ShareSummary;
  /** Set when analysis hit a resource limit or could not finish; the upload must be rejected. */
  rejectReason?: string;
};

/**
 * Inspects the encryption envelope and builds the public share summary for an uploaded archive.
 * Every ZIP read and player decode is bounded by `limits`.
 */
export async function analyzeArchive(
  bytes: Uint8Array,
  limits: ArchiveLoadLimits
): Promise<ArchiveAnalysis> {
  const envelope = await inspectArchiveEnvelope(bytes, limits);

  if (envelope.rejectReason) {
    return {
      envelope: envelope.summary,
      summary: createUnavailableShareSummary(envelope.summary.encrypted, envelope.rejectReason),
      rejectReason: envelope.rejectReason
    };
  }

  const summary = await buildShareSummary(bytes, envelope.summary, limits);
  return summary.rejectReason
    ? { envelope: envelope.summary, summary: summary.summary, rejectReason: summary.rejectReason }
    : { envelope: envelope.summary, summary: summary.summary };
}

/** Envelope reported when the archive could not be inspected at all. */
export function createFailedEnvelopeSummary(analysisError: string): ArchiveEnvelopeSummary {
  return {
    encrypted: false,
    encryptedPrivatePathsComplete: false,
    missingEncryptedPaths: [],
    encryptedPrivatePathsConfidential: false,
    plaintextEncryptedPaths: [],
    analysisError
  };
}

/** Summary reported when the server could not analyze the archive. */
export function createUnavailableShareSummary(
  encrypted: boolean,
  analysisError: string
): ShareSummary {
  return {
    schemaVersion: 1,
    source: "unavailable",
    analyzed: false,
    encrypted,
    analysisError
  };
}

type AnalysisStep<TValue> = {
  summary: TValue;
  rejectReason?: string;
};

async function buildShareSummary(
  bytes: Uint8Array,
  envelope: ArchiveEnvelopeSummary,
  limits: ArchiveLoadLimits
): Promise<AnalysisStep<ShareSummary>> {
  try {
    const player = await WebBlackboxPlayer.open(bytes, { limits });
    const manifest = player.archive.manifest;
    const derived = player.buildDerived();
    const actions = player.getActionTimeline();
    const privacyReport = player.getPrivacyProtectionReport();

    const summary: ShareSummary = {
      schemaVersion: 1,
      source: "server",
      analyzed: true,
      encrypted: envelope.encrypted || Boolean(manifest.encryption),
      manifest: {
        mode: manifest.mode,
        chunkCodec: manifest.chunkCodec,
        recordedAt: manifest.createdAt
      },
      totals: {
        events: derived.totals.events,
        blobs: player.archive.privacyManifest?.totals.blobs,
        privacyViolations: player.archive.privacyManifest?.totals.privacyViolations,
        errors: derived.totals.errors,
        requests: derived.totals.requests,
        actions: derived.actionSpans.length,
        durationMs: Math.round(manifest.stats.durationMs)
      },
      topActionTriggers: collectTopActionTriggers(actions),
      privacy: {
        redaction: {
          hashSensitiveValues: privacyReport.redaction.hashSensitiveValues,
          headerRuleCount: privacyReport.redaction.headers.length,
          cookieRuleCount: privacyReport.redaction.cookieNames.length,
          bodyPatternCount: privacyReport.redaction.bodyPatterns.length,
          blockedSelectorCount: privacyReport.redaction.blockedSelectors.length
        },
        detected: privacyReport.detected,
        scanner: privacyReport.scanner,
        categories: player.archive.privacyManifest?.categories.map((category) => ({ ...category }))
      }
    };

    return { summary };
  } catch (error) {
    const analysisError = describeAnalysisError(error);
    return {
      summary: createUnavailableShareSummary(envelope.encrypted, analysisError),
      rejectReason: error instanceof ArchiveLimitError ? analysisError : undefined
    };
  }
}

async function inspectArchiveEnvelope(
  bytes: Uint8Array,
  limits: ArchiveLoadLimits
): Promise<AnalysisStep<ArchiveEnvelopeSummary>> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    assertArchiveWithinLimits(zip, limits);
    const manifest = asRecord(JSON.parse(await readZipText(zip, "manifest.json", limits)));
    const encryption = asRecord(manifest.encryption);
    const encrypted = Object.keys(encryption).length > 0;
    const encryptedFiles = asRecord(encryption.files);
    const privatePaths = collectArchivePrivatePaths(zip);
    const missingEncryptedPaths = encrypted
      ? privatePaths.filter((path) => !isEncryptedFileMeta(encryptedFiles[path]))
      : [];
    const plaintextEncryptedPaths = encrypted
      ? await collectPlaintextEncryptedPrivatePaths(zip, privatePaths, encryptedFiles, limits)
      : [];

    return {
      summary: {
        encrypted,
        encryptedPrivatePathsComplete: encrypted && missingEncryptedPaths.length === 0,
        missingEncryptedPaths,
        encryptedPrivatePathsConfidential: encrypted && plaintextEncryptedPaths.length === 0,
        plaintextEncryptedPaths
      }
    };
  } catch (error) {
    const analysisError = describeAnalysisError(error);
    return {
      summary: createFailedEnvelopeSummary(analysisError),
      rejectReason: error instanceof ArchiveLimitError ? analysisError : undefined
    };
  }
}

function describeAnalysisError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error), 240);
}

function collectArchivePrivatePaths(zip: JSZip): string[] {
  return Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .map(([path]) => path)
    .filter(isArchivePrivatePath)
    .sort();
}

function isArchivePrivatePath(path: string): boolean {
  return (
    path.startsWith("events/") ||
    path.startsWith("blobs/") ||
    path === "index/time.json" ||
    path === "index/req.json" ||
    path === "index/inv.json" ||
    path === "privacy/manifest.json"
  );
}

function isEncryptedFileMeta(value: unknown): boolean {
  const record = asRecord(value);
  if (typeof record.ivBase64 !== "string") {
    return false;
  }

  const iv = decodeBase64Strict(record.ivBase64.trim());
  return iv !== null && iv.byteLength === AES_GCM_IV_BYTES;
}

async function collectPlaintextEncryptedPrivatePaths(
  zip: JSZip,
  privatePaths: string[],
  encryptedFiles: Record<string, unknown>,
  limits: ArchiveLoadLimits
): Promise<string[]> {
  const plaintextPaths: string[] = [];

  for (const path of privatePaths) {
    if (!isEncryptedFileMeta(encryptedFiles[path])) {
      continue;
    }

    const file = zip.file(path);
    if (!file) {
      continue;
    }

    const bytes = await readZipEntryBytes(file, limits);
    if (looksLikePlaintextPrivateArchiveFile(path, bytes)) {
      plaintextPaths.push(path);
    }
  }

  return plaintextPaths;
}

function looksLikePlaintextPrivateArchiveFile(path: string, bytes: Uint8Array): boolean {
  if (path === "index/time.json" || path === "index/req.json" || path === "index/inv.json") {
    return isPlainJsonBytes(bytes);
  }

  if (path === "privacy/manifest.json") {
    return isPlainJsonBytes(bytes);
  }

  if (path.startsWith("events/") && path.endsWith(".ndjson")) {
    return isPlainNdjsonBytes(bytes);
  }

  if (path.startsWith("blobs/")) {
    return looksLikePlaintextBlobFile(path, bytes);
  }

  return false;
}

function looksLikePlaintextBlobFile(path: string, bytes: Uint8Array): boolean {
  const normalizedPath = path.toLowerCase();

  if (normalizedPath.endsWith(".json")) {
    return isPlainJsonBytes(bytes);
  }

  if (normalizedPath.endsWith(".html")) {
    return isPlainHtmlBytes(bytes);
  }

  if (normalizedPath.endsWith(".png")) {
    return hasPngSignature(bytes);
  }

  if (normalizedPath.endsWith(".webp")) {
    return hasWebpSignature(bytes);
  }

  return isPlainJsonBytes(bytes) || isPlainHtmlBytes(bytes) || isPlainTextBytes(bytes);
}

function isPlainJsonBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isPlainNdjsonBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }

  try {
    for (const line of lines.slice(0, 32)) {
      JSON.parse(line);
    }
    return true;
  } catch {
    return false;
  }
}

function isPlainHtmlBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("<script") ||
    trimmed.includes("<body")
  );
}

function isPlainTextBytes(bytes: Uint8Array): boolean {
  const text = decodeUtf8Strict(bytes);
  if (!text) {
    return false;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  let printable = 0;

  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);

    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) {
      printable += 1;
    }
  }

  return printable / trimmed.length >= 0.9;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeBase64Strict(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/, "");
  const normalizedOutput = decoded.toString("base64").replace(/=+$/, "");

  return normalizedInput === normalizedOutput ? decoded : null;
}

async function readZipText(zip: JSZip, path: string, limits: ArchiveLoadLimits): Promise<string> {
  const file = zip.file(path);

  if (!file) {
    throw new Error(`Archive is missing required file: ${path}`);
  }

  return new TextDecoder().decode(await readZipEntryBytes(file, limits));
}

function collectTopActionTriggers(
  actions: ReturnType<WebBlackboxPlayer["getActionTimeline"]>
): ShareSummary["topActionTriggers"] {
  const counts = new Map<
    string,
    {
      triggerType: string;
      count: number;
      actionsWithErrors: number;
    }
  >();

  for (const action of actions) {
    const triggerType = action.triggerType ?? "unknown";
    const current = counts.get(triggerType) ?? {
      triggerType,
      count: 0,
      actionsWithErrors: 0
    };
    current.count += 1;
    if (action.errorCount > 0) {
      current.actionsWithErrors += 1;
    }
    counts.set(triggerType, current);
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)
    .map((entry) => ({
      triggerType: entry.triggerType,
      count: entry.count,
      errorRate: roundTo(entry.count > 0 ? entry.actionsWithErrors / entry.count : 0, 4)
    }));
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** Math.max(0, digits);
  return Math.round(value * factor) / factor;
}
