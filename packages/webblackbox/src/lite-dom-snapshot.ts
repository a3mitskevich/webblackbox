import { recordUrl, type CapturePolicy, type RedactionRules } from "@webblackbox/protocol";

import { capturesRawDom } from "./capture-scope.js";
import { serializeRawDom } from "./raw-dom-snapshot.js";

const DOM_SNAPSHOT_MAX_HTML_CHARS = 300_000;
const MUTATION_SAMPLE_TARGETS_MAX = 24;
const MUTATION_SAMPLE_ATTRIBUTES_MAX = 16;
export const OBSERVED_MUTATION_ATTRIBUTES = [
  "hidden",
  "open",
  "disabled",
  "checked",
  "selected",
  "aria-expanded",
  "aria-hidden",
  "aria-pressed",
  "aria-selected",
  "aria-current",
  "aria-busy",
  "href",
  "src"
];

export type MutationBatchSummary = {
  count: number;
  sampledCount: number;
  truncated: boolean;
  childListCount: number;
  attributeCount: number;
  characterDataCount: number;
  addedNodes: number;
  removedNodes: number;
  sampleTargets: string[];
  attributeNames: string[];
};

export type DomSnapshotSummaryMode = "pressure" | "large-dom" | "runtime-lite";

export function createEmptyMutationSummary(): MutationBatchSummary {
  return {
    count: 0,
    sampledCount: 0,
    truncated: false,
    childListCount: 0,
    attributeCount: 0,
    characterDataCount: 0,
    addedNodes: 0,
    removedNodes: 0,
    sampleTargets: [],
    attributeNames: []
  };
}

/** Counts one mutation record into `summary`; with details it also samples attributes and targets. */
export function accumulateMutationRecord(
  summary: MutationBatchSummary,
  record: MutationRecord,
  includeDetails: boolean,
  readSelector: (target: EventTarget | null) => string
): void {
  summary.count += 1;
  summary.sampledCount += 1;
  summary.addedNodes += record.addedNodes.length;
  summary.removedNodes += record.removedNodes.length;

  if (record.type === "childList") {
    summary.childListCount += 1;
  } else if (record.type === "attributes") {
    summary.attributeCount += 1;
  } else if (record.type === "characterData") {
    summary.characterDataCount += 1;
  }

  if (!includeDetails) {
    return;
  }

  if (record.type === "attributes" && record.attributeName) {
    const names = summary.attributeNames;

    if (names.length < MUTATION_SAMPLE_ATTRIBUTES_MAX && !names.includes(record.attributeName)) {
      names.push(record.attributeName);
    }
  }

  const sampleTargets = summary.sampleTargets;

  if (sampleTargets.length >= MUTATION_SAMPLE_TARGETS_MAX) {
    return;
  }

  const selector = readSelector(record.target);

  if (!sampleTargets.includes(selector)) {
    sampleTargets.push(selector);
  }
}

/** rrweb-lite incremental snapshot event of a mutation batch. */
export function buildRrwebMutationPayload(
  summary: MutationBatchSummary,
  redaction: RedactionRules
): Record<string, unknown> {
  return {
    schema: "rrweb-lite/v1",
    event: {
      type: "incremental-snapshot",
      source: "mutation-summary",
      timestamp: Date.now(),
      data: {
        count: summary.count,
        sampledCount: summary.sampledCount,
        truncated: summary.truncated,
        childListCount: summary.childListCount,
        attributeCount: summary.attributeCount,
        characterDataCount: summary.characterDataCount,
        addedNodes: summary.addedNodes,
        removedNodes: summary.removedNodes,
        sampleTargets: [...summary.sampleTargets],
        attributeNames: [...summary.attributeNames]
      }
    },
    href: readPageUrl(redaction),
    title: document.title
  };
}

/** Summary-only DOM snapshot: page metadata instead of the page's markup. */
export function buildSummaryDomSnapshotPayload(options: {
  reason: string;
  nodeCount: number;
  summaryMode: DomSnapshotSummaryMode;
  redaction: RedactionRules;
}): Record<string, unknown> {
  const { reason, nodeCount, summaryMode, redaction } = options;
  const html = buildDomSnapshotSummaryHtml({
    href: readPageUrl(redaction),
    title: document.title,
    reason,
    nodeCount,
    summaryMode,
    capturedAtIso: new Date().toISOString()
  });
  const truncated = true;
  const sampledHtml = html.slice(0, DOM_SNAPSHOT_MAX_HTML_CHARS);

  return {
    reason,
    href: readPageUrl(redaction),
    title: document.title,
    nodeCount,
    htmlLength: html.length,
    truncated,
    html: sampledHtml,
    summaryOnly: true,
    summaryMode
  };
}

/** `dom: allow`: the page itself, masked by blocked selectors. Null when not recorded. */
export function buildRawDomSnapshotPayload(
  reason: string,
  nodeCount: number,
  capturePolicy: CapturePolicy
): Record<string, unknown> | null {
  const { categories, redaction } = capturePolicy;

  if (!capturesRawDom(categories)) {
    return null;
  }

  const snapshot = serializeRawDom(document, {
    blockedSelectors: redaction.blockedSelectors,
    keepInputValues: categories.inputs === "allow",
    sensitiveNamePatterns: redaction.redactBodyPatterns,
    redaction
  });

  if (!snapshot) {
    return null;
  }

  return {
    reason,
    href: readPageUrl(capturePolicy.redaction),
    title: document.title,
    nodeCount,
    htmlLength: snapshot.htmlLength,
    truncated: snapshot.truncated,
    html: snapshot.html,
    summaryOnly: false
  };
}

/** Summary snapshot taken once capture pressure ends (mutations went unrecorded meanwhile). */
export function buildPressureRecoverySnapshotPayload(
  redaction: RedactionRules
): Record<string, unknown> {
  const nodeCount = document.getElementsByTagName("*").length;
  const html = buildDomSnapshotSummaryHtml({
    href: readPageUrl(redaction),
    title: document.title,
    reason: "pressure-recovery",
    nodeCount,
    summaryMode: "pressure",
    capturedAtIso: new Date().toISOString()
  });

  return {
    reason: "pressure-recovery",
    href: readPageUrl(redaction),
    title: document.title,
    nodeCount,
    htmlLength: html.length,
    truncated: true,
    html,
    summaryOnly: true,
    summaryMode: "pressure"
  };
}

function buildDomSnapshotSummaryHtml(options: {
  href: string;
  title: string;
  reason: string;
  nodeCount: number;
  summaryMode: "pressure" | "large-dom" | "runtime-lite";
  capturedAtIso: string;
}): string {
  const body = [
    "<!doctype html>",
    `<html data-webblackbox-summary="true" data-summary-mode="${escapeHtml(options.summaryMode)}">`,
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(options.title || "WebBlackbox DOM Summary")}</title>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>WebBlackbox Lite DOM Summary</h1>",
    `<p>mode=${escapeHtml(options.summaryMode)}</p>`,
    `<p>reason=${escapeHtml(options.reason)}</p>`,
    `<p>href=${escapeHtml(options.href)}</p>`,
    `<p>title=${escapeHtml(options.title)}</p>`,
    `<p>nodeCount=${String(options.nodeCount)}</p>`,
    `<p>capturedAt=${escapeHtml(options.capturedAtIso)}</p>`,
    "</main>",
    "</body>",
    "</html>"
  ];

  return body.join("");
}

function readPageUrl(rules: RedactionRules): string {
  return typeof location !== "undefined" && typeof location.href === "string"
    ? recordUrl(location.href, rules)
    : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
