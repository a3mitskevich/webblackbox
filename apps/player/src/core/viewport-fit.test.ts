import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildViewportTimeline,
  fitContentRect,
  projectToFrame,
  resolveViewportAt,
  type ViewportSample
} from "./viewport-fit.js";

/** Chrome's tab capture without size constraints: a fixed 2560×1440 frame. */
const TAB_VIDEO = { width: 2560, height: 1440 };

function event(type: string, mono: number, data: Record<string, unknown>): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: mono,
    mono,
    type,
    id: `E-${mono}`,
    data
  } as WebBlackboxEvent;
}

function close(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  expect(actual.x).toBeCloseTo(expected.x, 1);
  expect(actual.y).toBeCloseTo(expected.y, 1);
}

describe("fitContentRect", () => {
  it("fills the frame when the page had the whole window (same aspect)", () => {
    expect(fitContentRect(TAB_VIDEO, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0,
      width: 2560,
      height: 1440
    });
  });

  it("pillarboxes a page narrowed by DevTools docked to the right", () => {
    // 1200×1080 CSS px → scaled by 1440/1080, centred horizontally.
    const rect = fitContentRect(TAB_VIDEO, { width: 1200, height: 1080 });
    expect(rect.height).toBe(1440);
    expect(rect.width).toBeCloseTo(1600, 6);
    expect(rect.x).toBeCloseTo(480, 6);
    expect(rect.y).toBe(0);
  });

  it("letterboxes a page shortened by DevTools docked to the bottom", () => {
    // 1920×700 CSS px → scaled by 2560/1920, centred vertically.
    const rect = fitContentRect(TAB_VIDEO, { width: 1920, height: 700 });
    expect(rect.width).toBe(2560);
    expect(rect.height).toBeCloseTo(933.33, 1);
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(253.33, 1);
  });

  it("ignores the device pixel ratio: the capture scales device pixels uniformly", () => {
    // DevTools open: 1569×1350 CSS px at dpr 1.125 in a 2560×1440 video.
    const atDpr = fitContentRect(TAB_VIDEO, { width: 1569, height: 1350, dpr: 1.125 });
    const atOne = fitContentRect(TAB_VIDEO, { width: 1569, height: 1350, dpr: 1 });
    expect(atDpr).toEqual(atOne);
    expect(atDpr.height).toBe(1440);
    expect(atDpr.width).toBeCloseTo(1673.6, 1);
    expect(atDpr.x).toBeCloseTo(443.2, 1);
  });

  it("uses the whole frame without a usable viewport", () => {
    const whole = { x: 0, y: 0, width: 2560, height: 1440 };
    expect(fitContentRect(TAB_VIDEO, null)).toEqual(whole);
    expect(fitContentRect(TAB_VIDEO, { width: 0, height: 900 })).toEqual(whole);
    expect(fitContentRect(TAB_VIDEO, { width: Number.NaN, height: 900 })).toEqual(whole);
  });

  it("is the identity for a screenshot of the viewport (device pixels, same aspect)", () => {
    const rect = fitContentRect({ width: 1765, height: 1519 }, { width: 1569, height: 1350 });
    expect(rect.x).toBeCloseTo(0, 0);
    expect(rect.y).toBeCloseTo(0, 0);
  });
});

describe("projectToFrame", () => {
  it("puts a click on the element it hit in a pillarboxed tab video", () => {
    const viewport = { width: 1569, height: 1350 };
    // The centre of a 46 px button at (97.6, 259.6) CSS px.
    close(projectToFrame(TAB_VIDEO, viewport, { x: 120.9, y: 282.9 }), { x: 572.2, y: 301.8 });
    // The page's top-left and bottom-right corners land on the content edges, not the bars.
    close(projectToFrame(TAB_VIDEO, viewport, { x: 0, y: 0 }), { x: 443.2, y: 0 });
    close(projectToFrame(TAB_VIDEO, viewport, { x: 1569, y: 1350 }), { x: 2116.8, y: 1440 });
  });

  it("maps through letterboxing when DevTools are docked to the bottom", () => {
    close(projectToFrame(TAB_VIDEO, { width: 1920, height: 700 }, { x: 960, y: 350 }), {
      x: 1280,
      y: 720
    });
    close(projectToFrame(TAB_VIDEO, { width: 1920, height: 700 }, { x: 0, y: 0 }), {
      x: 0,
      y: 253.3
    });
  });
});

describe("viewport timeline", () => {
  const events = [
    event("user.resize", 100, { reason: "start", width: 1920, height: 1080, dpr: 1 }),
    event("user.mousemove", 200, { x: 10, y: 10 }),
    event("user.click", 300, { x: 5, y: 5, viewport: { w: 1920, h: 1080, dpr: 1 } }),
    // An iframe's click: its own viewport, never the page's.
    event("user.click", 350, {
      x: 5,
      y: 5,
      frameOffset: { x: 40, y: 60 },
      viewport: { w: 300, h: 200, dpr: 1 }
    }),
    // DevTools docked to the right mid-session.
    event("user.resize", 400, { reason: "resize", width: 1200, height: 1080, dpr: 1.25 }),
    event("user.click", 500, { x: 5, y: 5, viewport: { w: 1200, h: 1080, dpr: 1.25 } }),
    event("user.resize", 600, { reason: "resize", width: 0, height: 1080 })
  ];

  it("collects top-frame viewports in time order and drops repeats and junk", () => {
    expect(buildViewportTimeline(events)).toEqual<ViewportSample[]>([
      { mono: 100, width: 1920, height: 1080, dpr: 1 },
      { mono: 400, width: 1200, height: 1080, dpr: 1.25 }
    ]);
  });

  it("follows a mid-session resize", () => {
    const timeline = buildViewportTimeline(events);
    expect(resolveViewportAt(timeline, 399)?.width).toBe(1920);
    expect(resolveViewportAt(timeline, 400)?.width).toBe(1200);
    expect(resolveViewportAt(timeline, 10_000)?.width).toBe(1200);

    const before = fitContentRect(TAB_VIDEO, resolveViewportAt(timeline, 399));
    const after = fitContentRect(TAB_VIDEO, resolveViewportAt(timeline, 450));
    expect(before.x).toBe(0);
    expect(after.x).toBeCloseTo(480, 6);
  });

  it("uses the first known viewport before the first sample, and null without any", () => {
    const timeline = buildViewportTimeline(events);
    expect(resolveViewportAt(timeline, 0)?.width).toBe(1920);
    expect(resolveViewportAt([], 0)).toBeNull();
  });

  it("skips a cross-origin iframe's click (no frame offset, but recorded in a sub-frame)", () => {
    const crossOrigin = {
      ...event("user.click", 450, { x: 5, y: 5, viewport: { w: 300, h: 250, dpr: 1 } }),
      frame: "content-frame-7"
    };
    const timeline = buildViewportTimeline([...events, crossOrigin]);
    expect(timeline.map((sample) => sample.width)).toEqual([1920, 1200]);
    expect(resolveViewportAt(timeline, 460)?.width).toBe(1200);
  });

  it("reads click viewports when the archive has no resize events", () => {
    expect(
      buildViewportTimeline([
        event("user.click", 300, { x: 5, y: 5, viewport: { w: 1569, h: 1350, dpr: 1.13 } })
      ])
    ).toEqual([{ mono: 300, width: 1569, height: 1350, dpr: 1.13 }]);
  });
});
