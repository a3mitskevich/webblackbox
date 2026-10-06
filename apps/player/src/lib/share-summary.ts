import type { ActionTimelineEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";

/** Header carrying the client-side share summary on upload (read by the share server). */
export const SHARE_SUMMARY_HEADER = "x-webblackbox-share-summary";

/** What the client tells the share server about an uploaded archive (no event content). */
export type PublicShareSummary = {
  schemaVersion: 1;
  source: "client";
  analyzed: boolean;
  encrypted: boolean;
  manifest: {
    mode: string;
    chunkCodec: string;
    recordedAt: string;
  };
  totals: {
    events: number;
    blobs?: number;
    privacyViolations?: number;
    errors: number;
    requests: number;
    actions: number;
    durationMs: number;
  };
  topActionTriggers: Array<{
    triggerType: string;
    count: number;
    errorRate: number;
  }>;
  privacy: {
    redaction: {
      hashSensitiveValues: boolean;
      headerRuleCount: number;
      cookieRuleCount: number;
      bodyPatternCount: number;
      blockedSelectorCount: number;
    };
    detected: ReturnType<WebBlackboxPlayer["getPrivacyProtectionReport"]>["detected"];
    scanner: ReturnType<WebBlackboxPlayer["getPrivacyProtectionReport"]>["scanner"];
    categories?: NonNullable<WebBlackboxPlayer["archive"]["privacyManifest"]>["categories"];
  };
};

/** The client share summary of a loaded archive: counts, redaction profile, privacy signals. */
export function buildClientShareSummary(player: WebBlackboxPlayer): PublicShareSummary {
  const manifest = player.archive.manifest;
  const derived = player.buildDerived();
  const privacyReport = player.getPrivacyProtectionReport();

  return {
    schemaVersion: 1,
    source: "client",
    analyzed: true,
    encrypted: Boolean(manifest.encryption),
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
    topActionTriggers: buildPublicActionTriggerSummary(player.getActionTimeline()),
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
}

function buildPublicActionTriggerSummary(
  actions: ActionTimelineEntry[]
): PublicShareSummary["topActionTriggers"] {
  const counts = new Map<
    string,
    { triggerType: string; count: number; actionsWithErrors: number }
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
      errorRate: roundRatio(entry.count > 0 ? entry.actionsWithErrors / entry.count : 0)
    }));
}

/** The summary as an HTTP header value. */
export function encodeShareSummaryHeader(summary: PublicShareSummary): string {
  return encodeURIComponent(JSON.stringify(summary));
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
