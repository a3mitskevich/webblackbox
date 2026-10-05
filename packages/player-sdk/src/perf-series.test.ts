import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { buildPerformanceSeries, readLongTasks, readWebVitals } from "./perf-series.js";

let sequence = 0;

function event(type: string, mono: number, data: unknown): WebBlackboxEvent {
  sequence += 1;
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id: `E-${sequence}`,
    data
  };
}

describe("readLongTasks / readWebVitals", () => {
  const events = [
    event("perf.vitals", 100, { ttfb: 80 }),
    event("perf.longtask", 200, { name: "self", duration: 120 }),
    event("perf.vitals", 300, { metric: "largest-contentful-paint", startTime: 900 }),
    event("perf.vitals", 310, { metric: "layout-shift", value: 0.05 }),
    event("perf.vitals", 320, { metric: "layout-shift", value: 0.1 }),
    event("perf.vitals", 330, { metric: "first-input", duration: 16 }),
    event("perf.vitals", 340, { metric: "unknown", value: 1 }),
    event("perf.longtask", 400, { durationMs: 60 }),
    event("perf.longtask", 410, { name: "bad" }),
    event("perf.vitals", 500, { lcp: 1_200, inp: 240 })
  ];

  it("reads long tasks with their duration", () => {
    expect(readLongTasks(events)).toEqual([
      { eventId: events[1]?.id, mono: 200, durationMs: 120, name: "self" },
      { eventId: events[7]?.id, mono: 400, durationMs: 60 }
    ]);
  });

  it("merges summary and per-entry vitals up to a moment", () => {
    expect(readWebVitals(events, 250)).toEqual({ ttfb: 80 });

    const at400 = readWebVitals(events, 400);
    expect(at400.lcp).toBe(900);
    expect(at400.cls).toBeCloseTo(0.15);
    expect(at400.fid).toBe(16);
    expect(readWebVitals(events)).toMatchObject({ lcp: 1_200, inp: 240, ttfb: 80 });
  });
});

describe("buildPerformanceSeries", () => {
  it("buckets requests in flight, transfer, failures and long tasks", () => {
    const series = buildPerformanceSeries({
      events: [event("perf.longtask", 150, { duration: 70 })],
      requests: [
        { startMono: 0, endMono: 250, failed: false, status: 200, encodedDataLength: 2_048 },
        { startMono: 120, endMono: 130, failed: true },
        { startMono: 300, endMono: 290, failed: false, status: 404, encodedDataLength: 512 }
      ],
      minMono: 0,
      maxMono: 400,
      buckets: 4,
      minBucketMs: 10
    });

    expect(series.bucketMs).toBe(100);
    expect(series.offsets).toEqual([0, 100, 200, 300]);
    expect(series.requestsInFlight).toEqual([1, 2, 1, 1]);
    expect(series.transferKib).toEqual([0, 0, 2, 0.5]);
    expect(series.failedRequests).toEqual([0, 1, 0, 1]);
    expect(series.longTaskMs).toEqual([0, 70, 0, 0]);
  });

  it("keeps at least one bucket for an empty session", () => {
    const series = buildPerformanceSeries({ events: [], requests: [], minMono: 5, maxMono: 5 });

    expect(series.offsets).toEqual([0]);
    expect(series.requestsInFlight).toEqual([0]);
    expect(series.bucketMs).toBe(50);
  });
});
