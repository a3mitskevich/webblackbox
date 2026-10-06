import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import type { WebBlackboxPlayer } from "./index.js";
import type { PlayerRange, PrivacyProtectionReport, SensitiveDataPreview } from "./types.js";

export function buildPrivacyProtectionReport(
  player: Pick<WebBlackboxPlayer, "archive" | "query">,
  range?: PlayerRange
): PrivacyProtectionReport {
  const profile = player.archive.manifest.redactionProfile;
  const events = player.query({ range });
  const counters = countPrivacySignals(events, profile.redactBodyPatterns);

  return {
    encrypted: Boolean(player.archive.manifest.encryption),
    redaction: {
      hashSensitiveValues: profile.hashSensitiveValues,
      headers: [...profile.redactHeaders].sort(),
      cookieNames: [...profile.redactCookieNames].sort(),
      bodyPatterns: [...profile.redactBodyPatterns].sort(),
      blockedSelectors: [...profile.blockedSelectors].sort(),
      strategy: describeRedactionStrategy(profile)
    },
    detected: counters,
    scanner: player.archive.privacyManifest
      ? {
          preEncryption: player.archive.privacyManifest.scanner.preEncryption,
          status: player.archive.privacyManifest.scanner.status,
          findingCount: player.archive.privacyManifest.scanner.findings.length
        }
      : {
          preEncryption: false,
          status: "unknown",
          findingCount: 0
        }
  };
}

export function buildSensitiveDataPreview(
  player: Pick<WebBlackboxPlayer, "archive" | "query">,
  options: NonNullable<Parameters<WebBlackboxPlayer["getSensitiveDataPreview"]>[0]>
): SensitiveDataPreview {
  const limit = Math.max(1, options.limit ?? 25);
  const patterns = player.archive.manifest.redactionProfile.redactBodyPatterns;
  const samples: SensitiveDataPreview["samples"] = [];
  let totalMatches = 0;

  for (const event of player.query({ range: options.range })) {
    const matches = collectSensitivePreviewMatches(event, patterns);
    totalMatches += matches.length;

    for (const match of matches) {
      if (samples.length >= limit) {
        continue;
      }

      samples.push(match);
    }
  }

  return {
    totalMatches,
    samples
  };
}

function describeRedactionStrategy(profile: ExportManifest["redactionProfile"]): string[] {
  const strategy = [
    `Redacts ${profile.redactHeaders.length} sensitive HTTP header names before archive export.`,
    `Masks ${profile.redactCookieNames.length} configured cookie names in cookie headers and snapshots.`,
    `Scans payload keys/text for ${profile.redactBodyPatterns.length} sensitive body patterns.`,
    `Blocks ${profile.blockedSelectors.length} configured DOM selectors from captured text/value payloads.`
  ];

  strategy.push(
    profile.hashSensitiveValues
      ? "Hashes sensitive string values so correlation remains possible without exposing raw secrets."
      : "Replaces sensitive values with fixed redaction markers."
  );

  return strategy;
}

function countPrivacySignals(
  events: WebBlackboxEvent[],
  sensitivePatterns: string[]
): PrivacyProtectionReport["detected"] {
  let redactedMarkers = 0;
  let hashedSensitiveValues = 0;
  let sensitiveKeyMentions = 0;
  const normalizedPatterns = sensitivePatterns
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean);

  for (const event of events) {
    const serialized = safeStringify(event.data);
    redactedMarkers += countMatches(serialized, /\[(?:REDACTED|redacted(?:-[a-z]+)?)\]/g);
    hashedSensitiveValues += countMatches(serialized, /\b[a-f0-9]{64}\b/g);
    const lowered = serialized.toLowerCase();

    for (const pattern of normalizedPatterns) {
      if (lowered.includes(pattern)) {
        sensitiveKeyMentions += 1;
      }
    }
  }

  return {
    redactedMarkers,
    hashedSensitiveValues,
    sensitiveKeyMentions
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function collectSensitivePreviewMatches(
  event: WebBlackboxEvent,
  sensitivePatterns: string[]
): SensitiveDataPreview["samples"] {
  const serialized = safeStringify(event.data);
  const matches: SensitiveDataPreview["samples"] = [];
  const addMatch = (reason: SensitiveDataPreview["samples"][number]["reason"], snippet: string) => {
    matches.push({
      eventId: event.id,
      type: event.type,
      mono: event.mono,
      reason,
      snippet: compactSensitiveSnippet(snippet)
    });
  };

  for (const match of serialized.matchAll(/\[(?:REDACTED|redacted(?:-[a-z]+)?)\]/g)) {
    addMatch("redacted-marker", match[0]);
  }

  for (const match of serialized.matchAll(/\b[a-f0-9]{64}\b/g)) {
    addMatch("hashed-value", match[0]);
  }

  const lowered = serialized.toLowerCase();
  for (const pattern of sensitivePatterns) {
    const normalized = pattern.trim().toLowerCase();
    if (normalized && lowered.includes(normalized)) {
      addMatch("sensitive-pattern", normalized);
    }
  }

  return matches;
}

function compactSensitiveSnippet(value: string): string {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    return `${value.slice(0, 8)}…${value.slice(-6)}`;
  }

  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}
