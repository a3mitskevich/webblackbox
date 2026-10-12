import type { ExportCompleteness } from "@webblackbox/player-sdk";
import type { ArchiveTruncation, ArchiveTruncationReason } from "@webblackbox/protocol";

import { formatRecordedAt } from "../core/format.js";

type ExportNoticeKey =
  | "exportInterrupted"
  | "exportInterruptedLastSeen"
  | "exportLeftOutWindow"
  | "exportLeftOutSize"
  | "exportLeftOutScreenshots"
  | "exportLeftOutVideo"
  | "exportLeftOutUnreadable";

type ExportSummaryKey = "exportWhole" | "exportPartial" | "exportNotRecorded";

export type ExportNoticeMessages = {
  locale: string;
  tn: (key: ExportNoticeKey | ExportSummaryKey, values?: Record<string, string | number>) => string;
  formatNumber: (value: number) => string;
  formatByteSize: (bytes: number) => string;
};

const TRUNCATION_KEYS: Record<ArchiveTruncationReason, ExportNoticeKey> = {
  "recent-window": "exportLeftOutWindow",
  "size-limit": "exportLeftOutSize",
  "screenshots-excluded": "exportLeftOutScreenshots",
  "screen-recordings-excluded": "exportLeftOutVideo",
  "chunk-unreadable": "exportLeftOutUnreadable"
};
const MS_PER_MINUTE = 60_000;

/**
 * Warnings for a recording the archive does not hold whole: it was interrupted (ended without
 * Stop), or the export left part of it out. Empty for a whole export and for older archives,
 * which do not say what their export left out.
 */
export function formatExportNotices(
  report: ExportCompleteness,
  messages: ExportNoticeMessages
): string[] {
  const interruption = report.interruption
    ? [
        report.interruption.lastSeenAt !== undefined
          ? messages.tn("exportInterruptedLastSeen", {
              detected: formatTime(report.interruption.detectedAt, messages.locale),
              lastSeen: formatTime(report.interruption.lastSeenAt, messages.locale)
            })
          : messages.tn("exportInterrupted", {
              detected: formatTime(report.interruption.detectedAt, messages.locale)
            })
      ]
    : [];

  return [...interruption, ...report.truncations.map((row) => formatTruncation(row, messages))];
}

/** One sentence on how much of the recording the archive holds. */
export function formatExportSummary(
  report: ExportCompleteness,
  messages: ExportNoticeMessages
): string {
  if (!report.recorded || report.storedEvents === null) {
    return messages.tn("exportNotRecorded", {
      events: messages.formatNumber(report.exportedEvents)
    });
  }

  return messages.tn(report.whole ? "exportWhole" : "exportPartial", {
    exported: messages.formatNumber(report.exportedEvents),
    stored: messages.formatNumber(report.storedEvents)
  });
}

function formatTruncation(row: ArchiveTruncation, messages: ExportNoticeMessages): string {
  return messages.tn(TRUNCATION_KEYS[row.reason], {
    events: messages.formatNumber(row.events),
    minutes: messages.formatNumber(Math.max(1, Math.round((row.limit ?? 0) / MS_PER_MINUTE))),
    size: messages.formatByteSize(row.limit ?? 0)
  });
}

function formatTime(ms: number, locale: string): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : formatRecordedAt(date.toISOString(), locale);
}
