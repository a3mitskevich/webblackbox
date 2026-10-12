import { describe, expect, it } from "vitest";

import { createPlayerI18n } from "./i18n.js";
import { formatExportNotices, formatExportSummary } from "./export-completeness-view.js";

const WHOLE = {
  recorded: true,
  whole: true,
  storedEvents: 1200,
  exportedEvents: 1200,
  truncations: [],
  interruption: null
};

describe("export completeness view", () => {
  const i18n = createPlayerI18n("en");

  it("has nothing to warn about for a whole recording or an older archive", () => {
    expect(formatExportNotices(WHOLE, i18n)).toEqual([]);
    expect(formatExportSummary(WHOLE, i18n)).toBe(
      "The archive holds the whole recording: 1,200 of 1,200 events."
    );
    expect(
      formatExportSummary(
        { ...WHOLE, recorded: false, whole: false, storedEvents: null, exportedEvents: 5 },
        i18n
      )
    ).toMatch(/^Events: 5\. This archive was exported by an older version/);
  });

  it("explains an interrupted recording and each truncation", () => {
    const notices = formatExportNotices(
      {
        ...WHOLE,
        whole: false,
        exportedEvents: 400,
        interruption: {
          reason: "service-worker-restart",
          detectedAt: Date.UTC(2026, 0, 1, 11, 0),
          lastSeenAt: Date.UTC(2026, 0, 1, 10, 59)
        },
        truncations: [
          { reason: "recent-window", events: 700, chunks: 9, limit: 30 * 60_000 },
          { reason: "size-limit", events: 90, chunks: 1, limit: 50 * 1024 * 1024 },
          { reason: "screenshots-excluded", events: 8, chunks: 0 },
          { reason: "screen-recordings-excluded", events: 2, chunks: 0 },
          { reason: "chunk-unreadable", events: 3, chunks: 1 }
        ]
      },
      i18n
    );

    expect(notices).toHaveLength(6);
    expect(notices[0]).toMatch(/^The recording was interrupted: .*last seen recording .*noticed/);
    expect(notices.slice(1)).toEqual([
      "The export left out 700 events older than its 30-minute window.",
      "The export left out the oldest 90 events to stay under 50.00 MB.",
      "The export left out 8 screenshots.",
      "The export left out the tab video (2 events).",
      "3 recorded events could not be read back and are missing."
    ]);
  });

  it("is translated", () => {
    const report = {
      ...WHOLE,
      interruption: { reason: "service-worker-restart" as const, detectedAt: 0 }
    };

    expect(formatExportNotices(report, createPlayerI18n("ru"))[0]).toMatch(/^Запись прервана/);
    expect(formatExportNotices(report, createPlayerI18n("zh-CN"))[0]).toMatch(/^录制被中断/);
  });
});
