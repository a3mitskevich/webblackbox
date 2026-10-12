import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";
import { RRWEB_EVENT_SCHEMA, type WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildRrwebTimeline,
  clickAt,
  CLICK_HIGHLIGHT_WINDOW_MS,
  monoAtTimestamp,
  selectReplayResources,
  timestampAtMono
} from "./replay-model.js";

let nextId = 0;

function batchEvent(
  tab: number,
  mono: number,
  events: Array<{ type: number; timestamp: number; data: unknown }>
): WebBlackboxEvent {
  nextId += 1;
  return {
    v: 1,
    sid: "S",
    tab,
    t: events[0]?.timestamp ?? 0,
    mono,
    type: "dom.rrweb.event",
    id: `E-${nextId}`,
    data: { schema: RRWEB_EVENT_SCHEMA, events }
  };
}

const meta = (timestamp: number) => ({ type: 4, timestamp, data: { href: "https://a.test/" } });
const full = (timestamp: number) => ({ type: 2, timestamp, data: { node: {} } });
const click = (timestamp: number, id: number) => ({
  type: 3,
  timestamp,
  data: { source: 2, type: 2, id, x: 10, y: 20 }
});
const move = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1, positions: [] } });

describe("buildRrwebTimeline", () => {
  it("returns null without rrweb batches (lite summaries do not count)", () => {
    const summary: WebBlackboxEvent = {
      ...batchEvent(1, 0, []),
      data: { schema: "rrweb-lite/v1", event: {} }
    };

    expect(buildRrwebTimeline([summary])).toBeNull();
  });

  it("orders the events of the busiest tab and maps page time to archive time", () => {
    const timeline = buildRrwebTimeline([
      batchEvent(1, 5_000, [click(1_005_000, 7), move(1_005_100)]),
      batchEvent(1, 1_000, [meta(1_001_000), full(1_001_000)]),
      batchEvent(2, 1_500, [meta(2_000_000)])
    ])!;

    expect(timeline.tab).toBe(1);
    expect(timeline.otherTabs).toEqual([2]);
    expect(timeline.events.map((event) => event.timestamp)).toEqual([
      1_001_000, 1_001_000, 1_005_000, 1_005_100
    ]);
    expect(timeline.fullSnapshots).toBe(1);
    expect(timestampAtMono(timeline, 3_000)).toBe(1_003_000);
    expect(monoAtTimestamp(timeline, 1_005_000)).toBe(5_000);
    expect(timeline.clicks).toEqual([
      { timestamp: 1_005_000, mono: 5_000, nodeId: 7, x: 10, y: 20 }
    ]);
  });

  it("uses the first batch for times before it", () => {
    const timeline = buildRrwebTimeline([batchEvent(1, 1_000, [meta(10_000), full(10_000)])])!;

    expect(timestampAtMono(timeline, 0)).toBe(9_000);
  });
});

describe("clickAt", () => {
  const timeline = buildRrwebTimeline([
    batchEvent(1, 0, [meta(0), full(0)]),
    batchEvent(1, 1_000, [click(1_000, 3)])
  ])!;

  it("highlights a click shortly after it and not before or long after", () => {
    expect(clickAt(timeline, 999)).toBeNull();
    expect(clickAt(timeline, 1_000)?.nodeId).toBe(3);
    expect(clickAt(timeline, 1_000 + CLICK_HIGHLIGHT_WINDOW_MS)?.nodeId).toBe(3);
    expect(clickAt(timeline, 1_001 + CLICK_HIGHLIGHT_WINDOW_MS)).toBeNull();
  });
});

describe("selectReplayResources", () => {
  const entry = (overrides: Partial<NetworkWaterfallEntry>) =>
    ({
      url: "https://a.test/x",
      mimeType: "text/css",
      responseBodyHash: "h1",
      ...overrides
    }) as NetworkWaterfallEntry;

  it("keeps whole stylesheet, image and font bodies, first per URL", () => {
    expect(
      selectReplayResources([
        entry({ url: "https://a.test/a.css" }),
        entry({ url: "https://a.test/a.css", responseBodyHash: "h2" }),
        entry({ url: "https://a.test/i.png", mimeType: "image/png", responseBodyHash: "h3" }),
        entry({ url: "https://a.test/f.woff2", mimeType: "font/woff2", responseBodyHash: "h4" }),
        entry({ url: "https://a.test/api", mimeType: "application/json" }),
        entry({ url: "https://a.test/b.css", responseBodyHash: undefined }),
        entry({ url: "https://a.test/c.css", responseBodyTruncated: true })
      ]).map((resource) => [resource.url, resource.hash])
    ).toEqual([
      ["https://a.test/a.css", "h1"],
      ["https://a.test/i.png", "h3"],
      ["https://a.test/f.woff2", "h4"]
    ]);
  });
});
