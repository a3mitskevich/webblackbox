import {
  DEFAULT_EXPORT_POLICY,
  assertExportPassphrase,
  isValidExportPassphrase,
  normalizeExportPassphrase,
  type CaptureMode,
  type ExportPolicy,
  type PrivacyScannerResult
} from "@webblackbox/protocol";

import type { ExportPrivacyWarning, ExtensionOutboundMessage } from "../shared/messages.js";
import type { PipelineExportDownloadResult } from "../shared/offscreen-messages.js";
import { resolveLocalDataSettings } from "../shared/profiles/local-data.js";
import type { SessionRuntime } from "./session-registry.js";
import type { SnapshotStorageAreaLike } from "./stopped-session-store.js";

export type ExportAuditEvent = {
  schemaVersion: 1;
  timestamp: string;
  sid: string;
  mode: CaptureMode;
  outcome: "ok" | "error";
  encrypted: boolean;
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number;
  recentWindowMs: number;
  sizeBytes?: number;
  downloadId?: number;
  error?: string;
};

export const EXPORT_AUDIT_STORAGE_KEY = "webblackbox.audit.exports";
export const EXPORT_AUDIT_MAX_EVENTS = 200;

export type ExportSessionResult =
  | { ok: true; fileName: string; privacyWarning?: ExportPrivacyWarning }
  | { ok: false; error: string };

export type ExportDownloadsApiLike = {
  download(options: { url: string; filename: string; saveAs?: boolean }): Promise<number>;
};

/**
 * What the export flow needs from the rest of the worker: the registry lookup, the stop and
 * pipeline-drain steps, the stopped-session lifecycle hooks, the ordered per-session queue, the
 * downloads relay and the audit storage area. The audit area is `storage.local`; without it no
 * audit event is kept.
 */
export type SessionExportDeps = {
  getRuntimeBySid: (sid: string) => SessionRuntime | undefined;
  stopSession: (tabId: number) => Promise<void>;
  flushBufferedPipelineEvents: (runtime: SessionRuntime) => Promise<void>;
  attachStoppedPipeline: (runtime: SessionRuntime) => Promise<void>;
  disposeStoppedSession: (runtime: SessionRuntime) => Promise<void>;
  enqueueWithResult: <TResult>(
    runtime: SessionRuntime,
    task: () => Promise<TResult>
  ) => Promise<TResult>;
  downloads: ExportDownloadsApiLike | undefined;
  auditStorageArea: SnapshotStorageAreaLike | undefined;
  broadcast: (message: ExtensionOutboundMessage) => void;
};

export type SessionExportController = {
  exportSession: (
    sid: string,
    passphrase: string | undefined,
    saveAs?: boolean,
    policy?: ExportPolicy
  ) => Promise<ExportSessionResult>;
  resolveExportPolicy: (value: unknown) => ExportPolicy;
  appendExportAuditEvent: (event: ExportAuditEvent) => Promise<void>;
};

export function resolveSessionExportPolicy(
  runtime: SessionRuntime,
  policy: ExportPolicy
): ExportPolicy {
  if (runtime.mode !== "full" || !runtime.config.capturePolicy) {
    return policy;
  }

  // A mid-session switch must not drop visuals recorded while an earlier profile allowed them.
  const { visualsCaptured } = runtime.profile;

  return {
    ...policy,
    includeScreenshots: visualsCaptured.screenshots,
    includeScreenRecordings: visualsCaptured.screenRecordings
  };
}

export function resolveExportPolicy(value: unknown): ExportPolicy {
  const row = asRecord(value);
  const includeScreenshots =
    typeof row?.includeScreenshots === "boolean"
      ? row.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;
  const includeScreenRecordings =
    typeof row?.includeScreenRecordings === "boolean"
      ? row.includeScreenRecordings
      : DEFAULT_EXPORT_POLICY.includeScreenRecordings;

  return {
    includeScreenshots,
    includeScreenRecordings,
    maxArchiveBytes: normalizeExportBoundedInt(
      row?.maxArchiveBytes,
      DEFAULT_EXPORT_POLICY.maxArchiveBytes,
      64 * 1024,
      5 * 1024 * 1024 * 1024
    ),
    recentWindowMs: normalizeExportBoundedInt(
      row?.recentWindowMs,
      DEFAULT_EXPORT_POLICY.recentWindowMs,
      1 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000
    )
  };
}

export function normalizeExportBoundedInt(
  candidate: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const value = asFiniteNumber(candidate);

  if (value === null || value <= 0) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

export function buildExportPrivacyWarning(
  scanner: PrivacyScannerResult | undefined
): ExportPrivacyWarning | undefined {
  if (scanner?.status !== "blocked" || scanner.findings.length === 0) {
    return undefined;
  }

  const findings = scanner.findings.slice(0, 8).map((finding) => ({
    kind: finding.kind,
    path: finding.path,
    matchCount: finding.matchCount
  }));
  const summary = findings
    .slice(0, 5)
    .map((finding) => `${finding.kind} in ${finding.path}`)
    .join(", ");

  return {
    findingCount: scanner.findings.length,
    summary,
    findings
  };
}

export async function downloadExportedBundle(
  downloads: ExportDownloadsApiLike | undefined,
  exported: PipelineExportDownloadResult,
  saveAs: boolean
): Promise<void> {
  if (!downloads?.download) {
    throw new Error("Downloads API is unavailable in service worker context.");
  }

  const downloadId = await downloads.download({
    url: exported.downloadUrl,
    filename: `webblackbox/${exported.fileName}`,
    saveAs
  });

  exported.downloadId = downloadId;
}

export function redactOperationalMessage(message: string): string {
  return message
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted-token]")
    .replaceAll(/\b(?:https?|file):\/\/[^\s)]+/gi, "[redacted-url]")
    .slice(0, 240);
}

/**
 * The export flow: policy resolution, the passphrase gate, the pipeline export and download
 * relay, the audit event and the privacy-scanner warning broadcast.
 */
export function createSessionExportController(deps: SessionExportDeps): SessionExportController {
  async function appendExportAuditEvent(event: ExportAuditEvent): Promise<void> {
    const storage = deps.auditStorageArea;

    if (!storage) {
      return;
    }

    const values = await storage.get(EXPORT_AUDIT_STORAGE_KEY);
    const current = Array.isArray(values[EXPORT_AUDIT_STORAGE_KEY])
      ? (values[EXPORT_AUDIT_STORAGE_KEY] as unknown[])
      : [];
    const events = [...current.slice(-EXPORT_AUDIT_MAX_EVENTS + 1), event];

    await storage.set({
      [EXPORT_AUDIT_STORAGE_KEY]: events
    });
  }

  async function exportSession(
    sid: string,
    passphrase: string | undefined,
    saveAs = true,
    policy: ExportPolicy = DEFAULT_EXPORT_POLICY
  ): Promise<ExportSessionResult> {
    const runtime = deps.getRuntimeBySid(sid);

    if (!runtime) {
      const error = "Session not found for export.";
      console.warn("[WebBlackbox] export ignored; unknown session", sid);
      deps.broadcast({
        kind: "sw.export-status",
        sid,
        ok: false,
        error
      });
      return {
        ok: false,
        error
      };
    }

    const effectivePolicy = resolveSessionExportPolicy(runtime, policy);
    // Every archive is encrypted, whatever the profile; whitespace around it is not part of it.
    const encryptionPassphrase = normalizeExportPassphrase(passphrase);

    try {
      // Before stopping the session: a refused export leaves the recording running.
      assertExportPassphrase(encryptionPassphrase);

      if (!runtime.stoppedAt) {
        await deps.stopSession(runtime.tabId);
      }

      await deps.flushBufferedPipelineEvents(runtime);
      await deps.attachStoppedPipeline(runtime);

      const exported = await deps.enqueueWithResult(runtime, async () => {
        return runtime.pipeline.exportAndDownload({
          passphrase: encryptionPassphrase,
          includeScreenshots: effectivePolicy.includeScreenshots,
          includeScreenRecordings: effectivePolicy.includeScreenRecordings,
          maxArchiveBytes: effectivePolicy.maxArchiveBytes,
          recentWindowMs: effectivePolicy.recentWindowMs
        });
      });

      await downloadExportedBundle(deps.downloads, exported, saveAs);
      const privacyWarning = buildExportPrivacyWarning(exported.privacyScanner);
      await appendExportAuditEvent({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        sid,
        mode: runtime.mode,
        outcome: "ok",
        encrypted: true,
        includeScreenshots: effectivePolicy.includeScreenshots,
        includeScreenRecordings: effectivePolicy.includeScreenRecordings,
        maxArchiveBytes: effectivePolicy.maxArchiveBytes,
        recentWindowMs: effectivePolicy.recentWindowMs,
        sizeBytes: exported.sizeBytes,
        downloadId: exported.downloadId
      });
      deps.broadcast({
        kind: "sw.export-status",
        sid,
        ok: true,
        fileName: exported.fileName,
        privacyWarning
      });

      // The profile decides whether the local copy goes now or waits out its retention.
      if (
        runtime.stoppedAt &&
        resolveLocalDataSettings(runtime.profile.selection.profile).deleteAfterExport
      ) {
        await deps.disposeStoppedSession(runtime);
      }

      return {
        ok: true,
        fileName: exported.fileName,
        privacyWarning
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendExportAuditEvent({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        sid,
        mode: runtime.mode,
        outcome: "error",
        encrypted: isValidExportPassphrase(encryptionPassphrase),
        includeScreenshots: effectivePolicy.includeScreenshots,
        includeScreenRecordings: effectivePolicy.includeScreenRecordings,
        maxArchiveBytes: effectivePolicy.maxArchiveBytes,
        recentWindowMs: effectivePolicy.recentWindowMs,
        error: redactOperationalMessage(message)
      });
      console.warn("[WebBlackbox] export failed", error);
      deps.broadcast({
        kind: "sw.export-status",
        sid,
        ok: false,
        error: message
      });
      return {
        ok: false,
        error: message
      };
    }
  }

  return {
    exportSession,
    resolveExportPolicy,
    appendExportAuditEvent
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
