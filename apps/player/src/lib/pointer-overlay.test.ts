import type { PointerTimelineEntry } from "@webblackbox/player-sdk";
import { describe, expect, it } from "vitest";

import {
  buildPointerLaneMarks,
  buildRippleMarks,
  projectOverlayPoint,
  toOverlayActions
} from "./pointer-overlay.js";

function entry(
  mono: number,
  kind: PointerTimelineEntry["kind"],
  extra: Partial<PointerTimelineEntry> = {}
): PointerTimelineEntry {
  return {
    eventId: `E-${mono}`,
    type: "user.click",
    kind,
    mono,
    t: mono,
    label: kind,
    x: 10,
    y: 20,
    ...extra
  };
}

const noSignals = { rageClicks: [], deadClicks: [], deadClickCoverage: true };

describe("pointer overlay model", () => {
  it("keeps stage-drawable actions and shifts iframe points into the top viewport", () => {
    const actions = toOverlayActions([
      entry(30, "right", { frameOffset: { x: 100, y: 50 } }),
      entry(10, "click"),
      entry(20, "hover"),
      entry(40, "drag", { startX: 0, startY: 0, x: 90, y: 0 })
    ]);

    expect(actions).toEqual([
      { mono: 10, kind: "click", x: 10, y: 20 },
      { mono: 30, kind: "right", x: 110, y: 70 },
      { mono: 40, kind: "drag", x: 90, y: 0, startX: 0, startY: 0 }
    ]);
  });

  it("fades ripples out over the window before the playhead", () => {
    const actions = toOverlayActions([
      entry(0, "click"),
      entry(1_000, "hold"),
      entry(2_000, "click")
    ]);

    expect(buildRippleMarks(actions, 1_300).map((mark) => [mark.kind, mark.progress])).toEqual([
      ["hold", 0.25]
    ]);
    expect(buildRippleMarks(actions, 1_000, 1_200).map((mark) => mark.mono)).toEqual([0, 1_000]);
    expect(buildRippleMarks(actions, -5)).toEqual([]);
  });

  it("projects recorded CSS pixels onto a letterboxed stage", () => {
    const frame = { width: 800, height: 600, sourceWidth: 1600, sourceHeight: 900 };

    expect(projectOverlayPoint(frame, 800, 450)).toEqual({ x: 400, y: 300 });
    expect(projectOverlayPoint(frame, 0, 0)).toEqual({ x: 0, y: 75 });
  });

  it("adds rage and dead clicks to the lane and keeps the most telling mark per slot", () => {
    const label = (kind: string) => kind.toUpperCase();
    const marks = buildPointerLaneMarks(
      [entry(0, "click"), entry(5, "click"), entry(1_000, "right", { target: 'button "Save"' })],
      {
        rageClicks: [{ startMono: 4, endMono: 6, count: 3, x: 1, y: 1, eventIds: ["E-4"] }],
        deadClicks: [{ eventId: "E-5", mono: 5, evidence: "reaction-probe" }],
        deadClickCoverage: true
      },
      label,
      2
    );

    expect(marks.map((mark) => [mark.kind, mark.tone])).toEqual([
      ["rage", "problem"],
      ["right", "alt"]
    ]);
    expect(marks[1]?.label).toBe('RIGHT: button "Save"');
    expect(buildPointerLaneMarks([], noSignals, label)).toEqual([]);
  });
});
