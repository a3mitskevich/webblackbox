import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPTURE_POLICY,
  DEFAULT_POINTER_CAPTURE_OPTIONS,
  DEFAULT_RECORDER_CONFIG,
  keepReadableSelector,
  maskPointerLabel,
  maskPointerLabels,
  stripUnreadablePointerDetail,
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

describe("stripUnreadablePointerDetail", () => {
  const readableTarget = { tag: "BUTTON", readable: { text: "Save", css: "#save" } };
  const allow = (dom: "allow" | "masked") => ({
    ...DEFAULT_CAPTURE_POLICY,
    categories: { ...DEFAULT_CAPTURE_POLICY.categories, actions: "allow" as const, dom }
  });

  it("drops readable targets and selection text the policy does not allow", () => {
    const drag = { kind: "dnd", target: readableTarget, dropTarget: readableTarget };

    expect(stripUnreadablePointerDetail("user.drag.end", drag, DEFAULT_CAPTURE_POLICY)).toEqual({
      kind: "dnd",
      target: { tag: "BUTTON" },
      dropTarget: { tag: "BUTTON" }
    });
    expect(
      stripUnreadablePointerDetail("user.selection", { length: 4, text: "abcd" }, allow("masked"))
    ).toEqual({ length: 4 });
  });

  it("returns the same payload when everything is allowed or nothing applies", () => {
    const click = { x: 1, y: 1, target: readableTarget };
    const selection = { length: 4, text: "abcd" };
    const network = { target: readableTarget };

    expect(stripUnreadablePointerDetail("user.click", click, allow("masked"))).toBe(click);
    expect(stripUnreadablePointerDetail("user.selection", selection, allow("allow"))).toBe(
      selection
    );
    expect(stripUnreadablePointerDetail("network.request", network, DEFAULT_CAPTURE_POLICY)).toBe(
      network
    );
  });
});

describe("maskPointerLabels", () => {
  const rules = { valuePatterns: [{ pattern: "acct-\\d+", targets: ["dom" as const] }] };

  it("masks each readable label, drops a changed selector and masks selected text", () => {
    const readable = {
      role: "button acct-1",
      ariaLabel: "Pay acct-2",
      text: "Pay acct-3",
      testId: "pay-acct-4",
      name: "acct-5",
      css: '[name="acct-5"]'
    };

    expect(
      maskPointerLabels(
        "user.drag.end",
        { target: { tag: "A", readable }, dropTarget: { tag: "B", readable } },
        rules
      )
    ).toEqual({
      target: {
        tag: "A",
        readable: {
          role: "button [REDACTED]",
          ariaLabel: "Pay [REDACTED]",
          text: "Pay [REDACTED]",
          testId: "pay-[REDACTED]",
          name: "[REDACTED]"
        }
      },
      dropTarget: {
        tag: "B",
        readable: {
          role: "button [REDACTED]",
          ariaLabel: "Pay [REDACTED]",
          text: "Pay [REDACTED]",
          testId: "pay-[REDACTED]",
          name: "[REDACTED]"
        }
      }
    });
    expect(maskPointerLabels("user.selection", { length: 6, text: "acct-7" }, rules)).toEqual({
      length: 6,
      text: "[REDACTED]"
    });
  });

  it("keeps labels as recorded when masking is off, nothing matches or rules target bodies", () => {
    const click = { target: { tag: "A", readable: { text: "Pay acct-3", css: "#pay" } } };

    expect(maskPointerLabels("user.click", click, { ...rules, contentRedaction: false })).toBe(
      click
    );
    expect(
      maskPointerLabels("user.click", { target: { readable: { text: "Hi" } } }, rules)
    ).toEqual({
      target: { readable: { text: "Hi" } }
    });
    expect(
      maskPointerLabels("user.click", click, {
        valuePatterns: [{ pattern: "acct-\\d+", targets: ["bodies"] }]
      })
    ).toBe(click);
  });
});

describe("readable label helpers", () => {
  const anchored = { valuePatterns: [{ pattern: "^acme-\\d+$", targets: ["dom" as const] }] };

  it("keeps a selector only when no embedded value or id is masked", () => {
    expect(keepReadableSelector('[data-testid="acme-12"]', anchored)).toBeUndefined();
    expect(keepReadableSelector("main > #acme-34 > button", anchored)).toBeUndefined();
    expect(keepReadableSelector('button[name="say \\"hi\\""]', anchored)).toBe(
      'button[name="say \\"hi\\""]'
    );
    expect(
      keepReadableSelector('[data-testid="acme-12"]', { ...anchored, contentRedaction: false })
    ).toBe('[data-testid="acme-12"]');
  });

  it("masks a label in its raw and its collapsed form", () => {
    const rules = { valuePatterns: [{ pattern: "Pulse DOM", targets: ["dom" as const] }] };

    expect(maskPointerLabel("Pulse\n   DOM now", rules)).toBe("[REDACTED] now");
    expect(maskPointerLabel("Pulse DOM", rules)).toBe("[REDACTED]");
  });
});
