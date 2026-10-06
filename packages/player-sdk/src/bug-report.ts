import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { isErrorEvent } from "./event-query.js";
import type { WebBlackboxPlayer } from "./index.js";
import { detectPointerSignals, type PointerSignals } from "./pointer-insights.js";
import { formatTabsContextReport, readTabsContext } from "./tabs-context.js";
import type {
  BugReportOptions,
  GitHubIssueTemplate,
  JiraIssueTemplate,
  TeamIssueTemplateOptions
} from "./types.js";
import { asRecord, asString } from "./value-readers.js";

export function buildBugReport(
  player: Pick<
    WebBlackboxPlayer,
    "query" | "getNetworkWaterfall" | "getReplayDiagnostics" | "buildDerived" | "archive"
  >,
  options: BugReportOptions
): string {
  const maxItems = Math.max(5, options.maxItems ?? 20);
  const scoped = player.query({ range: options.range });
  const errors = scoped.filter(isErrorEvent).slice(0, maxItems);
  const markers = scoped.filter((event) => event.type === "user.marker").slice(0, maxItems);
  const failedRequests = player
    .getNetworkWaterfall(options.range)
    .filter((entry) => entry.failed || (entry.status !== undefined && entry.status >= 400))
    .slice(0, maxItems);
  const slowRequests = player
    .getNetworkWaterfall(options.range)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, maxItems);
  const replayDiagnostics = player.getReplayDiagnostics({
    range: options.range,
    limit: Math.min(maxItems, 10)
  });

  const heading = options.title ?? "WebBlackbox Bug Report";
  const derived = player.buildDerived(options.range);
  // The whole session: what was open in parallel does not depend on the selected range.
  const tabsContext = readTabsContext(player.query());
  const pointerSignals = detectPointerSignals(scoped);
  const notCaptured = player
    .getNetworkWaterfall(options.range)
    .filter((entry) => entry.responseBodySkip || entry.requestBodySkipReason)
    .slice(0, maxItems);

  return [
    `# ${heading}`,
    "",
    "## Session",
    `- Origin: ${player.archive.manifest.site.origin}`,
    `- Mode: ${player.archive.manifest.mode}`,
    `- Visible Events: ${scoped.length}`,
    `- Action Spans: ${derived.actionSpans.length}`,
    `- Errors: ${derived.totals.errors}`,
    `- Requests: ${derived.totals.requests}`,
    "",
    "## Parallel Tabs",
    ...formatTabsContextReport(tabsContext, maxItems),
    "",
    "## Markers",
    markers.length === 0
      ? "- None"
      : markers
          .map((event) => `- ${event.id} @ ${event.mono.toFixed(2)}ms ${compactEventText(event)}`)
          .join("\n"),
    "",
    "## Errors",
    errors.length === 0
      ? "- None"
      : errors
          .map((event) => `- ${event.id} @ ${event.mono.toFixed(2)}ms ${compactEventText(event)}`)
          .join("\n"),
    "",
    "## Failed Requests",
    failedRequests.length === 0
      ? "- None"
      : failedRequests
          .map(
            (entry) =>
              `- ${entry.method} ${entry.url} -> ${entry.status ?? "FAILED"} (${entry.durationMs.toFixed(1)}ms)`
          )
          .join("\n"),
    "",
    "## Slow Requests",
    slowRequests.length === 0
      ? "- None"
      : slowRequests
          .map(
            (entry) =>
              `- ${entry.method} ${entry.url} (${entry.durationMs.toFixed(1)}ms${entry.actionId ? `, act=${entry.actionId}` : ""})`
          )
          .join("\n"),
    "",
    "## Not Captured",
    notCaptured.length === 0
      ? "- None"
      : notCaptured
          .map((entry) => {
            const parts = [
              entry.requestBodySkipReason ? `request body: ${entry.requestBodySkipReason}` : "",
              entry.responseBodySkip ? `response body: ${entry.responseBodySkip.reason}` : ""
            ].filter(Boolean);
            return `- ${entry.method} ${entry.url} (${parts.join("; ")})`;
          })
          .join("\n"),
    "",
    "## Replay Diagnostics",
    replayDiagnostics.length === 0
      ? "- None"
      : replayDiagnostics
          .map(
            (entry) =>
              `- ${entry.actId} confidence=${entry.confidence} chain=${entry.causeChain.join(" -> ")}`
          )
          .join("\n"),
    "",
    "## Pointer Signals",
    ...formatPointerSignals(pointerSignals, maxItems)
  ].join("\n");
}

export function buildGitHubIssueTemplate(
  player: Pick<WebBlackboxPlayer, "archive" | "generateBugReport">,
  options: TeamIssueTemplateOptions
): GitHubIssueTemplate {
  const title = options.title ?? `Bug: ${player.archive.manifest.site.origin} regression`;
  const body = player.generateBugReport({
    title: `${title} - WebBlackbox Evidence`,
    range: options.range,
    maxItems: options.maxItems
  });

  return {
    title,
    body,
    labels: options.labels ?? ["bug", "webblackbox"],
    assignees: options.assignees ?? []
  };
}

export function buildJiraIssueTemplate(
  player: Pick<WebBlackboxPlayer, "archive" | "generateBugReport">,
  options: TeamIssueTemplateOptions
): JiraIssueTemplate {
  const summary = options.title ?? `WebBlackbox: ${player.archive.manifest.site.origin} issue`;
  const description = player.generateBugReport({
    title: `${summary} - WebBlackbox Evidence`,
    range: options.range,
    maxItems: options.maxItems
  });

  return {
    fields: {
      summary,
      description,
      issuetype: {
        name: options.issueType ?? "Bug"
      },
      labels: options.labels ?? ["webblackbox", "flight-recorder"],
      project: options.projectKey
        ? {
            key: options.projectKey
          }
        : undefined,
      priority: options.priority
        ? {
            name: options.priority
          }
        : undefined
    }
  };
}

function formatPointerSignals(signals: PointerSignals, maxItems: number): string[] {
  const rage = signals.rageClicks
    .slice(0, maxItems)
    .map(
      (finding) =>
        `- Rage click: ${finding.count} clicks @ ${finding.startMono.toFixed(2)}ms at (${finding.x}, ${finding.y})${finding.target ? ` on ${finding.target}` : ""} [${finding.eventIds.join(", ")}]`
    );
  const dead = signals.deadClicks
    .slice(0, maxItems)
    .map(
      (finding) =>
        `- Dead click: ${finding.eventId} @ ${finding.mono.toFixed(2)}ms${finding.target ? ` on ${finding.target}` : ""} (no DOM change, request or navigation within 1s)`
    );
  const coverage = signals.deadClickCoverage
    ? []
    : ["- Dead clicks: not judged (the session has no DOM reaction data)"];
  const lines = [...rage, ...dead, ...coverage];

  return lines.length > 0 ? lines : ["- None"];
}

function compactEventText(event: WebBlackboxEvent): string {
  const payload = asRecord(event.data);
  const message =
    asString(payload?.message) ??
    asString(payload?.text) ??
    asString(payload?.url) ??
    asString(payload?.reason) ??
    asString(payload?.op);

  if (message) {
    return message;
  }

  const text = JSON.stringify(event.data);
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}
