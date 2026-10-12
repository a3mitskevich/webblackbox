import type {
  ArchiveTruncationReason,
  CapturePolicy,
  PrivacyManifest,
  WebBlackboxEvent
} from "@webblackbox/protocol";
import { DEFAULT_EXPORT_POLICY } from "@webblackbox/protocol";

import type { ExportBundleOptions } from "./session-export.js";

/** An export's policy with the recent-window cutoff resolved against the session. */
export type ResolvedExportPolicy = {
  includeScreenshots: boolean;
  includeScreenRecordings: boolean;
  maxArchiveBytes: number | null;
  recentWindowMs: number | null;
  cutoffTimestamp: number;
  /** False when the policy keeps every event: chunks are exported exactly as stored. */
  filtersEvents: boolean;
};

const SCREENSHOT_EVENT_TYPE: WebBlackboxEvent["type"] = "screen.screenshot";
const SCREEN_RECORDING_EVENT_PREFIX = "screen.recording.";

export function resolveExportPolicy(
  options: ExportBundleOptions,
  context: {
    latestEventTimestamp?: number;
    sessionStartedAt: number;
    sessionEndedAt?: number;
  }
): ResolvedExportPolicy {
  const includeScreenshots =
    typeof options.includeScreenshots === "boolean"
      ? options.includeScreenshots
      : DEFAULT_EXPORT_POLICY.includeScreenshots;
  const includeScreenRecordings =
    typeof options.includeScreenRecordings === "boolean"
      ? options.includeScreenRecordings
      : DEFAULT_EXPORT_POLICY.includeScreenRecordings;
  const maxArchiveBytes =
    options.maxArchiveBytes === null
      ? null
      : normalizeBoundedPositiveInt(
          options.maxArchiveBytes ?? DEFAULT_EXPORT_POLICY.maxArchiveBytes
        );
  const recentWindowMs =
    options.recentWindowMs === null
      ? null
      : normalizeBoundedPositiveInt(options.recentWindowMs ?? DEFAULT_EXPORT_POLICY.recentWindowMs);
  const anchorTimestamp =
    typeof context.sessionEndedAt === "number"
      ? Math.max(
          context.latestEventTimestamp ?? Number.NEGATIVE_INFINITY,
          context.sessionEndedAt,
          context.sessionStartedAt
        )
      : Math.max(
          Date.now(),
          context.latestEventTimestamp ?? Number.NEGATIVE_INFINITY,
          context.sessionStartedAt
        );
  const cutoffTimestamp =
    recentWindowMs === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(0, anchorTimestamp - recentWindowMs);

  return {
    includeScreenshots,
    includeScreenRecordings,
    maxArchiveBytes,
    recentWindowMs,
    cutoffTimestamp,
    filtersEvents: !includeScreenshots || !includeScreenRecordings || recentWindowMs !== null
  };
}

/** Why the policy leaves `event` out of the archive, or null when it is kept. */
export function exclusionReason(
  event: WebBlackboxEvent,
  policy: ResolvedExportPolicy
): ArchiveTruncationReason | null {
  if (event.t < policy.cutoffTimestamp) {
    return "recent-window";
  }

  if (!policy.includeScreenshots && event.type === SCREENSHOT_EVENT_TYPE) {
    return "screenshots-excluded";
  }

  if (!policy.includeScreenRecordings && event.type.startsWith(SCREEN_RECORDING_EVENT_PREFIX)) {
    return "screen-recordings-excluded";
  }

  return null;
}

export function buildExportTransferPolicy(
  capturePolicy: CapturePolicy | undefined,
  policy: ResolvedExportPolicy
): NonNullable<PrivacyManifest["transfer"]> {
  return {
    destination: "local-download",
    archiveKeyEnvelope: capturePolicy?.encryption.archiveKeyEnvelope ?? "passphrase",
    encrypted: true,
    includeScreenshots: policy.includeScreenshots,
    includeScreenRecordings: policy.includeScreenRecordings,
    maxArchiveBytes: policy.maxArchiveBytes,
    recentWindowMs: policy.recentWindowMs,
    shareEligible: true,
    computedAt: new Date().toISOString()
  };
}

function normalizeBoundedPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.max(1, Math.round(value));
}
