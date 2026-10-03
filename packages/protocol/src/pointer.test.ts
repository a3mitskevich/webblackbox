import { describe, expect, it } from "vitest";

import {
  DEFAULT_POINTER_CAPTURE_OPTIONS,
  DEFAULT_RECORDER_CONFIG,
  recorderConfigSchema,
  validateEvent,
  validateEventData,
  WEBBLACKBOX_EVENT_TYPES,
  WEBBLACKBOX_PROTOCOL_VERSION,
  type WebBlackboxEventType
} from "./index.js";

const geometry = {
  x: 120,
  y: 48,
  pageX: 120,
  pageY: 848,
  viewport: { w: 1280, h: 720, dpr: 2, scrollX: 0, scrollY: 800 },
  target: { tag: "BUTTON", rect: { x: 100, y: 30, w: 80, h: 32 } }
};

function envelope(type: WebBlackboxEventType, data: unknown) {
  return {
    v: WEBBLACKBOX_PROTOCOL_VERSION,
    sid: "S-1",
    tab: 1,
    t: 1_700_000_000_000,
    mono: 10,
    type,
    id: "E-1",
    data
  };
}

describe("pointer protocol", () => {
  it("registers every pointer event type", () => {
    for (const type of [
      "user.pointerdown",
      "user.pointerup",
      "user.contextmenu",
      "user.auxclick",
      "user.click.reaction",
      "user.drag.start",
      "user.drag.end",
      "user.selection",
      "user.wheel",
      "user.hover"
    ]) {
      expect(WEBBLACKBOX_EVENT_TYPES).toContain(type);
    }
  });

  it("validates press payloads with hold and long-press details", () => {
    const result = validateEvent(
      envelope("user.pointerup", {
        ...geometry,
        pointerType: "touch",
        button: 0,
        holdMs: 720,
        longPress: true,
        distance: 2
      })
    );

    expect(result.success).toBe(true);
    expect(
      validateEventData("user.pointerdown", { ...geometry, pointerType: "stylus", button: 0 })
        .success
    ).toBe(false);
  });

  it("validates drag, wheel, hover, selection and reaction payloads", () => {
    expect(
      validateEventData("user.drag.end", {
        ...geometry,
        kind: "dnd",
        startX: 10,
        startY: 10,
        distance: 120,
        dropTarget: { tag: "DIV" },
        dropEffect: "move",
        dropped: true
      }).success
    ).toBe(true);
    expect(
      validateEventData("user.wheel", {
        ...geometry,
        deltaX: 0,
        deltaY: -240,
        deltaMode: 0,
        count: 3,
        durationMs: 90,
        zoom: true,
        ctrlKey: true
      }).success
    ).toBe(true);
    expect(validateEventData("user.hover", { ...geometry, dwellMs: 650 }).success).toBe(true);
    expect(validateEventData("user.selection", { length: 12, editable: true }).success).toBe(true);
    expect(
      validateEventData("user.click.reaction", {
        clickMono: 10,
        mutated: true,
        latencyMs: 40,
        windowMs: 1000
      }).success
    ).toBe(true);
  });

  it("rejects unknown fields and oversized selection text", () => {
    expect(
      validateEventData("user.hover", { ...geometry, dwellMs: 600, html: "<b>x</b>" }).success
    ).toBe(false);
    expect(
      validateEventData("user.selection", { length: 500, text: "x".repeat(500) }).success
    ).toBe(false);
  });

  it("keeps recorder configs without pointer options valid", () => {
    expect(recorderConfigSchema.safeParse(DEFAULT_RECORDER_CONFIG).success).toBe(true);
    expect(
      recorderConfigSchema.safeParse({
        ...DEFAULT_RECORDER_CONFIG,
        pointer: DEFAULT_POINTER_CAPTURE_OPTIONS
      }).success
    ).toBe(true);
    expect(
      recorderConfigSchema.safeParse({
        ...DEFAULT_RECORDER_CONFIG,
        pointer: { hover: true }
      }).success
    ).toBe(false);
  });
});
