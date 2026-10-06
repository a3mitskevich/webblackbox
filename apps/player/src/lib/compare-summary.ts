import type { PlayerComparison } from "@webblackbox/player-sdk";

import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

const MAX_TYPE_DELTAS = 8;
const MAX_ENDPOINT_DELTAS = 5;
const MS_PER_SECOND = 1000;

export function formatCompareSummary(
  summary: PlayerComparison,
  locale: PlayerLocale = "en"
): string {
  const i18n = createPlayerI18n(locale);
  const { t } = i18n;
  const signedCount = (value: number): string => i18n.formatNumber(value, { signed: true });
  const signedDuration = (valueMs: number): string =>
    Math.abs(valueMs) >= MS_PER_SECOND
      ? i18n.formatSeconds(valueMs, { signed: true })
      : i18n.formatMilliseconds(valueMs, { signed: true });
  const lines = [
    t("compareSummaryTitle"),
    t("compareSummaryLeft", { id: summary.leftSessionId }),
    t("compareSummaryRight", { id: summary.rightSessionId }),
    "",
    t("compareSummaryTotals"),
    `- ${t("compareSummaryEvents", { value: signedCount(summary.eventDelta) })}`,
    `- ${t("compareSummaryErrors", { value: signedCount(summary.errorDelta) })}`,
    `- ${t("compareSummaryRequests", { value: signedCount(summary.requestDelta) })}`,
    `- ${t("compareSummaryDuration", { value: signedDuration(summary.durationDeltaMs) })}`
  ];

  const topTypeDeltas = summary.typeDeltas.slice(0, MAX_TYPE_DELTAS);

  if (topTypeDeltas.length > 0) {
    lines.push("", t("compareSummaryTopTypes"));

    for (const delta of topTypeDeltas) {
      lines.push(
        `- ${t("compareSummaryTypeDelta", {
          delta: signedCount(delta.delta),
          type: delta.type,
          left: i18n.formatNumber(delta.left),
          right: i18n.formatNumber(delta.right)
        })}`
      );
    }
  }

  const endpointDeltas = summary.endpointRegressions.slice(0, MAX_ENDPOINT_DELTAS);

  if (endpointDeltas.length > 0) {
    lines.push("", i18n.messages.compareHeadingEndpointRegressions);

    for (const endpoint of endpointDeltas) {
      lines.push(
        `- ${t("compareSummaryEndpoint", {
          endpoint: `${endpoint.method} ${endpoint.endpoint}`,
          countDelta: signedCount(endpoint.countDelta),
          leftCount: i18n.formatNumber(endpoint.leftCount),
          rightCount: i18n.formatNumber(endpoint.rightCount),
          failRate: i18n.formatNumber(endpoint.failureRateDelta, {
            percent: true,
            signed: true,
            fractionDigits: 2
          }),
          p95: signedDuration(endpoint.p95DurationDeltaMs)
        })}`
      );
    }
  }

  return lines.join("\n");
}
