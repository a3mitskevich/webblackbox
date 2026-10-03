import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildPlaywrightActionLines,
  isPlaywrightReplayableEvent,
  selectPlaywrightActions
} from "./playwright-actions.js";
import {
  buildPointerTimeline,
  describePointerTarget,
  detectDeadClicks,
  findGestureClickIds,
  detectRageClicks
} from "./pointer-insights.js";

let sequence = 0;

function event(
  type: WebBlackboxEvent["type"],
  mono: number,
  data: Record<string, unknown> = {},
  extra: Partial<WebBlackboxEvent> = {}
): WebBlackboxEvent {
  sequence += 1;
  return {
    v: 1,
    sid: "S-pointer",
    tab: 1,
    t: 1_700_000_000_000 + mono,
    mono,
    type,
    id: `E-${sequence}`,
    data,
    ...extra
  };
}

const saveButton = {
  tag: "BUTTON",
  readable: { role: "button", text: "Save", css: '[data-testid="save"]' }
};

function click(mono: number, x = 100, y = 100, target: Record<string, unknown> = saveButton) {
  return event("user.click", mono, { x, y, button: 0, target });
}

function reaction(clickMono: number, mutated: boolean) {
  return event("user.click.reaction", clickMono + (mutated ? 30 : 1_000), {
    clickMono,
    mutated,
    windowMs: 1_000
  });
}

describe("pointer timeline", () => {
  it("labels clicks, right/middle clicks, long presses, drags and wheel zoom", () => {
    const entries = buildPointerTimeline([
      click(10),
      event("user.dblclick", 20, { x: 1, y: 1, target: saveButton }),
      event("user.contextmenu", 30, { x: 5, y: 6, button: 2, target: saveButton }),
      event("user.auxclick", 40, { x: 5, y: 6, button: 1 }),
      event("user.pointerup", 50, {
        x: 1,
        y: 1,
        pointerType: "touch",
        button: 0,
        holdMs: 720,
        longPress: true
      }),
      event("user.pointerup", 55, { x: 1, y: 1, pointerType: "mouse", button: 0, holdMs: 40 }),
      event("user.drag.end", 60, {
        kind: "pointer",
        x: 200,
        y: 40,
        startX: 20,
        startY: 40,
        distance: 180,
        target: saveButton,
        dropTarget: { tag: "DIV", readable: { css: "#zone" } }
      }),
      event("user.wheel", 70, {
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: -120,
        deltaMode: 0,
        count: 2,
        durationMs: 40,
        zoom: true
      })
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "click",
      "double",
      "right",
      "middle",
      "hold",
      "drag",
      "zoom"
    ]);
    expect(entries[2]?.label).toBe('Right click on button "Save" ([data-testid="save"])');
    expect(entries[4]?.label).toBe("Long press (720 ms)");
    expect(entries[5]).toMatchObject({ startX: 20, startY: 40, x: 200, distance: 180 });
    expect(entries[5]?.label).toContain("to div (#zone)");
  });

  it("labels a held right button as a right click only", () => {
    const entries = buildPointerTimeline([
      event("user.pointerup", 10, { x: 1, y: 1, button: 2, holdMs: 700, longPress: true }),
      event("user.contextmenu", 12, { x: 1, y: 1, button: 2, target: saveButton })
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["right"]);
  });

  it("describes hashed targets by tag only", () => {
    expect(describePointerTarget({ tag: "BUTTON", idToken: "t_abc" })).toBe("button");
    expect(describePointerTarget(undefined)).toBeUndefined();
  });
});

describe("rage clicks", () => {
  it("flags three or more clicks within a second around one spot", () => {
    const findings = detectRageClicks([
      click(0, 100, 100),
      click(250, 104, 98),
      click(500, 102, 101),
      click(700, 99, 103),
      click(5_000, 100, 100)
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ count: 4, startMono: 0, endMono: 700, x: 100, y: 100 });
    expect(findings[0]?.target).toBe('button "Save" ([data-testid="save"])');
  });

  it("ignores slow clicks, scattered clicks and clicks in other frames", () => {
    expect(detectRageClicks([click(0), click(1_200), click(2_400)])).toHaveLength(0);
    expect(detectRageClicks([click(0, 0, 0), click(100, 200, 0), click(200, 400, 0)])).toHaveLength(
      0
    );
    expect(
      detectRageClicks([click(0), { ...click(100), frame: "content-iframe" }, click(200)])
    ).toHaveLength(0);
  });
});

describe("dead clicks", () => {
  it("uses the reaction probe and counts requests and navigations as reactions", () => {
    const dead = click(1_000);
    const mutated = click(3_000);
    const fetched = click(5_000);
    const { findings, coverage } = detectDeadClicks([
      dead,
      reaction(1_000, false),
      mutated,
      reaction(3_000, true),
      fetched,
      event("network.request", 5_200, { reqId: "R-1", url: "https://x.test", method: "GET" }),
      reaction(5_000, false)
    ]);

    expect(coverage).toBe(true);
    expect(findings.map((finding) => finding.eventId)).toEqual([dead.id]);
    expect(findings[0]).toMatchObject({ evidence: "reaction-probe", x: 100, y: 100 });
  });

  it("falls back to DOM mutation events and exempts form controls and links", () => {
    const { findings } = detectDeadClicks([
      event("dom.mutation.batch", 10, { count: 1 }),
      click(1_000),
      click(3_000),
      event("dom.mutation.batch", 3_300, { count: 2 }),
      click(5_000, 1, 1, { tag: "INPUT" }),
      click(7_000, 1, 1, { tag: "A", href: "/next" })
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ mono: 1_000, evidence: "dom-events" });
  });

  it("matches probes by capture mono when the events were re-timed", () => {
    const dead = click(1_000);
    const probe = reaction(1_000, true);
    // The Player's wall-clock fallback replaces mono with t; probes keep the capture mono.
    const retimed = [dead, probe].map((item) => ({ ...item, mono: item.t }));
    const rawMono = new Map([dead, probe].map((item) => [item.id, item.mono]));
    const earlier = event("dom.mutation.batch", dead.t - 500, { count: 1 });
    const tail = event("user.marker", dead.t + 5_000, {});
    const session = [earlier, ...retimed, tail];

    // Unmatched, the probe's "mutated" verdict is lost and the click looks dead.
    expect(detectDeadClicks(session).findings).toHaveLength(1);
    expect(
      detectDeadClicks(session, {
        captureMonoOf: (item) => rawMono.get(item.id) ?? item.mono
      }).findings
    ).toHaveLength(0);
  });

  it("skips the browser's click after a drag or long press and clicks at the session tail", () => {
    const afterSelection = click(1_020);
    const afterHold = click(3_010);
    const lastClick = click(9_500);
    const { findings } = detectDeadClicks([
      event("dom.mutation.batch", 10, { count: 1 }),
      event("user.pointerup", 1_000, { x: 1, y: 1, button: 0, distance: 120 }),
      afterSelection,
      event("user.pointerup", 3_000, { x: 1, y: 1, button: 0, holdMs: 700, longPress: true }),
      afterHold,
      event("dom.mutation.batch", 9_000, { count: 1 }),
      lastClick,
      event("user.marker", 9_900, {})
    ]);

    expect(findings).toEqual([]);
    expect(detectRageClicks([click(0), afterSelection, click(1_100)])).toHaveLength(0);
  });

  it("treats only the first click after a completed gesture as its follow-up", () => {
    const followUp = click(1_010);
    const userClick = click(1_060);
    const afterCancelled = click(3_010);
    const ids = findGestureClickIds([
      event("user.drag.end", 1_000, { kind: "pointer", x: 1, y: 1 }),
      followUp,
      userClick,
      event("user.drag.end", 3_000, { kind: "pointer", x: 1, y: 1, cancelled: true }),
      afterCancelled
    ]);

    expect([...ids]).toEqual([followUp.id]);
  });

  it("reports missing coverage instead of guessing", () => {
    const { findings, coverage } = detectDeadClicks([click(1_000), click(3_000)]);

    expect(coverage).toBe(false);
    expect(findings).toHaveLength(0);
  });
});

describe("Playwright action lines", () => {
  it("replays readable targets, right/middle clicks, long presses, hover, drags and wheel", () => {
    const events = [
      click(10),
      event("user.contextmenu", 20, { x: 1, y: 1, button: 2, target: saveButton }),
      event("user.auxclick", 30, { x: 1, y: 1, button: 1, target: saveButton }),
      event("user.pointerup", 40, {
        x: 1,
        y: 1,
        button: 0,
        holdMs: 640.4,
        longPress: true,
        target: saveButton
      }),
      click(60),
      event("user.hover", 70, { x: 1, y: 1, dwellMs: 600, target: saveButton }),
      event("user.drag.end", 80, {
        kind: "dnd",
        x: 300,
        y: 50,
        target: saveButton,
        dropTarget: { tag: "DIV", readable: { css: "#zone" } }
      }),
      event("user.drag.end", 90, { kind: "pointer", startX: 10, startY: 20, x: 110, y: 20 }),
      event("user.wheel", 100, {
        x: 5,
        y: 6,
        deltaX: 0,
        deltaY: 240,
        deltaMode: 0,
        count: 2,
        durationMs: 50,
        zoom: false
      })
    ];

    expect(buildPlaywrightActionLines(events)).toEqual([
      '  await page.click("[data-testid=\\"save\\"]");',
      '  await page.click("[data-testid=\\"save\\"]", {"button":"right"});',
      '  await page.click("[data-testid=\\"save\\"]", {"button":"middle"});',
      '  await page.click("[data-testid=\\"save\\"]", {"delay":640});',
      '  await page.hover("[data-testid=\\"save\\"]");',
      '  await page.dragAndDrop("[data-testid=\\"save\\"]", "#zone");',
      "  await page.mouse.move(10, 20);",
      "  await page.mouse.down();",
      "  await page.mouse.move(110, 20, { steps: 10 });",
      "  await page.mouse.up();",
      "  await page.mouse.move(5, 6);",
      "  await page.mouse.wheel(0, 240);"
    ]);
  });

  it("shifts iframe points into the page and skips cancelled drags", () => {
    const frameOffset = { x: 300, y: 200 };

    expect(
      buildPlaywrightActionLines([
        event("user.drag.end", 10, {
          kind: "pointer",
          startX: 10,
          startY: 20,
          x: 110,
          y: 20,
          frameOffset
        }),
        event("user.drag.end", 20, {
          kind: "pointer",
          startX: 1,
          startY: 1,
          x: 90,
          y: 1,
          cancelled: true
        }),
        event("user.drag.end", 30, { kind: "dnd", x: 9, y: 9, dropped: false, target: saveButton }),
        event("user.wheel", 40, { x: 5, y: 6, deltaX: 0, deltaY: 100, frameOffset })
      ])
    ).toEqual([
      "  await page.mouse.move(310, 220);",
      "  await page.mouse.down();",
      "  await page.mouse.move(410, 220, { steps: 10 });",
      "  await page.mouse.up();",
      "  // drag skipped (cancelled before the drop)",
      "  // drag skipped (cancelled before the drop)",
      "  await page.mouse.move(305, 206);",
      "  await page.mouse.wheel(0, 100);"
    ]);
  });

  it("never emits a masked selector or a raw line separator", () => {
    const masked = { tag: "A", readable: { css: "f".repeat(64) } };
    const sneaky = { tag: "INPUT", readable: { css: "#q" } };

    expect(
      buildPlaywrightActionLines([
        click(10, 1, 1, masked),
        event("user.input", 20, { target: sneaky, value: "x\u2028process.exit(1)" })
      ])
    ).toEqual([
      "  // user.click skipped (no selector)",
      '  await page.fill("#q", "x\\u2028process.exit(1)");'
    ]);
  });

  it("spends the action budget on replayable actions, not on follow-up clicks", () => {
    const hold = event("user.pointerup", 10, {
      x: 1,
      y: 1,
      button: 0,
      holdMs: 700,
      longPress: true,
      target: saveButton
    });
    const next = click(500);

    expect(selectPlaywrightActions([hold, click(20), next], 2)).toEqual([hold, next]);
  });

  it("never presses a key the capture redacted, nor spends budget on it", () => {
    const enter = event("user.keydown", 10, { key: "Enter" });
    const redacted = [
      event("user.keydown", 20, { key: "[REDACTED]" }),
      event("user.keydown", 30, { key: "[MASKED]" }),
      event("user.keydown", 40, { key: "a", redacted: true }),
      event("user.keydown", 50, { key: "" }),
      event("user.keydown", 60, { key: "f".repeat(64) })
    ];
    const tab = event("user.keydown", 70, { key: "Tab" });

    expect(buildPlaywrightActionLines([enter, ...redacted, tab])).toEqual([
      '  await page.keyboard.press("Enter");',
      '  await page.keyboard.press("Tab");'
    ]);
    expect(selectPlaywrightActions([enter, ...redacted, tab], 2)).toEqual([enter, tab]);
  });

  it("comments out targets the profile kept hashed", () => {
    const lines = buildPlaywrightActionLines([
      click(10, 1, 1, { tag: "BUTTON", selector: "selector:0123456789ab" }),
      click(20, 1, 1, { tag: "BUTTON", selector: "button[id:t_0abc]" })
    ]);

    expect(lines).toEqual([
      "  // user.click skipped (the recording profile kept the target hashed)",
      "  // user.click skipped (the recording profile kept the target hashed)"
    ]);
  });

  it("keeps non-replayable pointer noise out of the action budget", () => {
    expect(isPlaywrightReplayableEvent(event("user.mousemove", 1, { x: 1, y: 1 }))).toBe(false);
    expect(isPlaywrightReplayableEvent(event("user.pointerdown", 1, {}))).toBe(false);
    expect(isPlaywrightReplayableEvent(event("user.click.reaction", 1, {}))).toBe(false);
    expect(isPlaywrightReplayableEvent(click(1))).toBe(true);
  });
});
