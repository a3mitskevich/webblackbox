import type {
  CapturePolicy,
  PrivacyDataCategory,
  PrivacyManifest,
  PrivacyManifestCategorySummary,
  PrivacyScannerFinding,
  PrivacyScannerFindingKind,
  PrivacyScannerResult,
  WebBlackboxEvent
} from "@webblackbox/protocol";

import { sha256Hex } from "./hash.js";
import type { StoredBlob } from "./storage.js";

export type PrivacyManifestInput = {
  events: WebBlackboxEvent[];
  blobs: StoredBlob[];
  capturePolicy?: CapturePolicy;
  encrypted: boolean;
  transfer?: PrivacyManifest["transfer"];
  generatedAt?: Date;
};

type ScanTarget = {
  path: string;
  text: string;
};

type ScannerPattern = {
  kind: PrivacyScannerFindingKind;
  pattern: RegExp;
  validate?: (value: string) => boolean;
};

const SCANNER_PATTERNS: ScannerPattern[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=_-]{16,}\b/gi
  },
  {
    kind: "api-key",
    pattern: /\b(?:api[_-]?key|apikey|x-api-key)["'\s:=]+[A-Za-z0-9._~+/=_-]{16,}\b/gi
  },
  {
    kind: "oauth-code",
    pattern: /\b(?:oauth[_-]?code|code)["'\s:=]+[A-Za-z0-9._~-]{16,}\b/gi
  },
  {
    kind: "session-cookie",
    pattern: /\b(?:session|sessionid|sid|connect\.sid)=[A-Za-z0-9._~%+/=-]{12,}\b/gi
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    kind: "phone",
    pattern: /\b(?:\+?1[-.\s]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[-.\s]?\d{3}[-.\s]?\d{4}\b/g
  },
  {
    kind: "credit-card",
    pattern: /\b(?:card|credit[_-]?card|cc|pan)["'\s:=]+(?:\d[ -]*?){13,19}\b/gi,
    validate: hasValidLuhnChecksum
  },
  {
    kind: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    kind: "long-secret",
    pattern:
      /\b(?:secret|token|api[_-]?key|private[_-]?key|refresh[_-]?token)["'\s:=]+(?:[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})\b/gi
  }
];

/** Scanner findings, category counts and totals of a run of events (one chunk, say). */
export type PrivacyEventScan = {
  findings: PrivacyScannerFinding[];
  categories: PrivacyManifestCategorySummary[];
  events: number;
  privacyViolations: number;
};

export type PrivacyManifestParts = {
  /** Event scans in event order: their findings are listed in this order. */
  eventScans: PrivacyEventScan[];
  /** Findings per exported blob, in archive order. */
  blobFindings: PrivacyScannerFinding[][];
  blobCount: number;
  capturePolicy?: CapturePolicy;
  encrypted: boolean;
  transfer?: PrivacyManifest["transfer"];
  generatedAt?: Date;
};

export async function buildPrivacyManifest(input: PrivacyManifestInput): Promise<PrivacyManifest> {
  const blobFindings: PrivacyScannerFinding[][] = [];

  for (const blob of input.blobs) {
    blobFindings.push(await scanPrivacyBlob(blob));
  }

  return assemblePrivacyManifest({
    eventScans: [await scanPrivacyEvents(input.events)],
    blobFindings,
    blobCount: input.blobs.length,
    capturePolicy: input.capturePolicy,
    encrypted: input.encrypted,
    transfer: input.transfer,
    generatedAt: input.generatedAt
  });
}

/** Scans events for secrets and counts them by privacy category. */
export async function scanPrivacyEvents(events: WebBlackboxEvent[]): Promise<PrivacyEventScan> {
  return {
    findings: await scanPrivacyTargets(
      events.map((event) => ({
        path: `event:${event.id}`,
        text: extractEventScanText(event)
      }))
    ),
    categories: summarizePrivacyCategories(events),
    events: events.length,
    privacyViolations: events.filter((event) => event.type === "privacy.violation").length
  };
}

/** True when blobs of this type are text the scanner reads; other blobs need not be loaded. */
export function isPrivacyScannedMime(mime: string): boolean {
  return isLikelyTextBlob(mime);
}

/** Scanner findings for one blob (none for binary types). */
export function scanPrivacyBlob(
  blob: Pick<StoredBlob, "hash" | "mime" | "bytes">
): Promise<PrivacyScannerFinding[]> {
  return scanPrivacyTargets([{ path: `blob:${blob.hash}`, text: decodeBlobForScanning(blob) }]);
}

/** Builds the privacy manifest from scans gathered piece by piece. */
export function assemblePrivacyManifest(parts: PrivacyManifestParts): PrivacyManifest {
  const generatedAt = parts.generatedAt ?? new Date();
  const findings = [
    ...parts.eventScans.flatMap((scan) => scan.findings),
    ...parts.blobFindings.flat()
  ];
  const scanner: PrivacyScannerResult = {
    scannedAt: new Date().toISOString(),
    preEncryption: true,
    // "blocked" is the archived name for "findings to review": exports never stop on it.
    status: findings.length > 0 ? "blocked" : "passed",
    findings
  };

  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    effectivePolicy: parts.capturePolicy,
    consent: parts.capturePolicy?.consent,
    transfer: parts.transfer,
    categories: mergeCategorySummaries(parts.eventScans.map((scan) => scan.categories)),
    scanner,
    encryption: {
      archive: parts.encrypted ? "encrypted" : "plaintext",
      algorithm: parts.encrypted ? "AES-GCM" : undefined
    },
    totals: {
      events: parts.eventScans.reduce((sum, scan) => sum + scan.events, 0),
      blobs: parts.blobCount,
      privacyViolations: parts.eventScans.reduce((sum, scan) => sum + scan.privacyViolations, 0)
    }
  };
}

function extractEventScanText(event: WebBlackboxEvent): string {
  if (event.type === "meta.config") {
    return "";
  }

  const strings: string[] = [];
  collectStringLeaves(event.data, strings);
  collectStringLeaves(event.ref, strings);
  collectStringLeaves(event.cdp, strings);
  collectStringLeaves(event.frame, strings);
  return strings.join("\n");
}

function collectStringLeaves(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, output);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectStringLeaves(item, output);
  }
}

async function scanPrivacyTargets(targets: ScanTarget[]): Promise<PrivacyScannerFinding[]> {
  const findings: PrivacyScannerFinding[] = [];

  for (const target of targets) {
    if (!target.text) {
      continue;
    }

    for (const scanner of SCANNER_PATTERNS) {
      const matches = collectMatches(target.text, scanner);

      if (matches.length === 0) {
        continue;
      }

      findings.push({
        kind: scanner.kind,
        severity: "high",
        path: target.path,
        matchCount: matches.length,
        sampleSha256: await sha256Hex(matches[0] ?? "")
      });
    }
  }

  return findings;
}

function collectMatches(text: string, scanner: ScannerPattern): string[] {
  const output: string[] = [];

  for (const match of text.matchAll(scanner.pattern)) {
    const value = match[0];

    if (!value || scanner.validate?.(value) === false) {
      continue;
    }

    output.push(value);

    if (output.length >= 25) {
      break;
    }
  }

  return output;
}

function summarizePrivacyCategories(events: WebBlackboxEvent[]): PrivacyManifestCategorySummary[] {
  const summaries = new Map<PrivacyDataCategory, PrivacyManifestCategorySummary>();

  for (const event of events) {
    const privacy = event.privacy;

    if (!privacy) {
      continue;
    }

    const summary =
      summaries.get(privacy.category) ??
      ({
        category: privacy.category,
        events: 0,
        low: 0,
        medium: 0,
        high: 0,
        redacted: 0,
        unredacted: 0
      } satisfies PrivacyManifestCategorySummary);

    summary.events += 1;
    summary[privacy.sensitivity] += 1;

    if (privacy.redacted) {
      summary.redacted += 1;
    } else {
      summary.unredacted += 1;
    }

    summaries.set(privacy.category, summary);
  }

  return [...summaries.values()].sort((left, right) => left.category.localeCompare(right.category));
}

function mergeCategorySummaries(
  groups: PrivacyManifestCategorySummary[][]
): PrivacyManifestCategorySummary[] {
  const merged = new Map<PrivacyDataCategory, PrivacyManifestCategorySummary>();

  for (const summary of groups.flat()) {
    const existing = merged.get(summary.category);

    merged.set(
      summary.category,
      existing
        ? {
            category: summary.category,
            events: existing.events + summary.events,
            low: existing.low + summary.low,
            medium: existing.medium + summary.medium,
            high: existing.high + summary.high,
            redacted: existing.redacted + summary.redacted,
            unredacted: existing.unredacted + summary.unredacted
          }
        : summary
    );
  }

  return [...merged.values()].sort((left, right) => left.category.localeCompare(right.category));
}

function decodeBlobForScanning(blob: Pick<StoredBlob, "mime" | "bytes">): string {
  if (!isLikelyTextBlob(blob.mime)) {
    return "";
  }

  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes);
  } catch {
    return "";
  }
}

function isLikelyTextBlob(mime: string): boolean {
  const normalized = mime.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function hasValidLuhnChecksum(value: string): boolean {
  const digits = value.replace(/\D/g, "");

  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let doubleNext = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);

    if (!Number.isInteger(digit)) {
      return false;
    }

    if (doubleNext) {
      digit *= 2;

      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    doubleNext = !doubleNext;
  }

  return sum % 10 === 0;
}
