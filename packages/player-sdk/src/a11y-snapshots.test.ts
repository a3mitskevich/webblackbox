import type { DomA11ySnapshotData, WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { findOnPage, findPageStateAt, listA11ySnapshots } from "./a11y-snapshots.js";

function event(
  id: string,
  type: string,
  mono: number,
  data: unknown,
  act?: string
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_700_000_000_000 + mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id,
    data,
    ...(act ? { ref: { act } } : {})
  };
}

function snapshot(
  tree: string,
  trigger: DomA11ySnapshotData["trigger"] = { kind: "action" }
): DomA11ySnapshotData {
  return {
    trigger,
    url: "https://shop.test/checkout",
    viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 0 },
    scope: "viewport",
    tree,
    nodeCount: tree.split("\n").length,
    omittedNodes: 0,
    truncated: false,
    masking: "masked",
    durationMs: 2
  };
}

const FORM = '- textbox "Card" [required]\n- button "Pay"';
const DECLINED = `${FORM}\n- alert: "Card declined"`;
const SPINNER = `${FORM}\n- progressbar "Loading" [busy]`;

const EVENTS: WebBlackboxEvent[] = [
  event("E-1", "dom.a11y.snapshot", 100, snapshot(FORM, { kind: "navigation" })),
  event("E-2", "user.click", 1_000, {}, "A-1"),
  event("E-3", "network.request", 1_050, {}, "A-1"),
  event(
    "E-4",
    "dom.a11y.snapshot",
    1_700,
    snapshot(SPINNER, { kind: "action", eventId: "E-2" }),
    "A-1"
  ),
  event("E-5", "error.exception", 2_500, { message: "boom" }),
  event("E-6", "dom.a11y.snapshot", 2_800, snapshot(DECLINED, { kind: "error", eventId: "E-5" })),
  event("E-7", "dom.a11y.snapshot", 4_000, snapshot(FORM, { kind: "action" })),
  event("E-8", "dom.a11y.snapshot", 9_000, { tree: "malformed" })
];

describe("listA11ySnapshots", () => {
  it("lists valid snapshots in time order with their action", () => {
    const snapshots = listA11ySnapshots([...EVENTS].reverse());

    expect(snapshots.map((entry) => entry.eventId)).toEqual(["E-1", "E-4", "E-6", "E-7"]);
    expect(snapshots[1]).toMatchObject({ actionId: "A-1", mono: 1_700 });
  });
});

describe("findPageStateAt", () => {
  it("finds the snapshot an event triggered plus its neighbours", () => {
    const state = findPageStateAt(EVENTS, { eventId: "E-5" });

    expect(state?.anchor).toMatchObject({
      mono: 2_500,
      eventId: "E-5",
      eventType: "error.exception"
    });
    expect(state?.linked?.eventId).toBe("E-6");
    expect(state?.before?.eventId).toBe("E-4");
    expect(state?.after?.eventId).toBe("E-6");
  });

  it("finds the snapshot of an action", () => {
    const state = findPageStateAt(EVENTS, { actionId: "A-1" });

    expect(state?.anchor).toMatchObject({ mono: 1_000, actionId: "A-1" });
    expect(state?.linked?.eventId).toBe("E-4");
    expect(state?.before?.eventId).toBe("E-1");
  });

  it("resolves a derived action id from the action timeline by its first event", () => {
    const state = findPageStateAt(EVENTS, { actionId: "derived:E-5" });

    expect(state?.anchor).toMatchObject({ eventId: "E-5", mono: 2_500 });
    expect(state?.linked?.eventId).toBe("E-6");
    expect(findPageStateAt(EVENTS, { actionId: "derived:nope" })).toBeNull();
  });

  it("resolves monotonic and wall-clock times", () => {
    expect(findPageStateAt(EVENTS, { mono: 3_000 })?.before?.eventId).toBe("E-6");
    expect(findPageStateAt(EVENTS, { t: 1_700_000_000_000 + 3_000 })?.after?.eventId).toBe("E-7");
  });

  it("returns null for an unknown anchor", () => {
    expect(findPageStateAt(EVENTS, { eventId: "nope" })).toBeNull();
    expect(findPageStateAt(EVENTS, {})).toBeNull();
  });
});

describe("findOnPage", () => {
  const snapshots = listA11ySnapshots(EVENTS);

  it("reports when a text appeared and disappeared", () => {
    const result = findOnPage(snapshots, { text: "declined" });

    expect(result).toEqual({
      snapshotsScanned: 4,
      presentAtEnd: false,
      spans: [
        {
          appeared: { eventId: "E-6", t: 1_700_000_002_800, mono: 2_800, masking: "masked" },
          lastSeen: { eventId: "E-6", t: 1_700_000_002_800, mono: 2_800, masking: "masked" },
          disappeared: { eventId: "E-7", t: 1_700_000_004_000, mono: 4_000, masking: "masked" },
          sample: ['alert: "Card declined"']
        }
      ]
    });
  });

  it("matches roles, alone or with a text, within a range", () => {
    expect(findOnPage(snapshots, { role: "progressbar" }).spans[0]?.sample).toEqual([
      'progressbar "Loading" [busy]'
    ]);
    expect(findOnPage(snapshots, { role: "button", text: "pay" })).toMatchObject({
      presentAtEnd: true,
      spans: [{ appeared: { eventId: "E-1" }, lastSeen: { eventId: "E-7" } }]
    });
    expect(
      findOnPage(snapshots, { role: "button", monoStart: 2_000, monoEnd: 3_000 })
    ).toMatchObject({
      snapshotsScanned: 1,
      presentAtEnd: true
    });
  });

  it("marks a disappearance on a snapshot the capture cut as uncertain", () => {
    const cut = listA11ySnapshots([
      event("C-1", "dom.a11y.snapshot", 100, snapshot(DECLINED, { kind: "error" })),
      event("C-2", "dom.a11y.snapshot", 200, {
        ...snapshot(FORM, { kind: "action" }),
        truncated: true,
        omittedNodes: 40
      })
    ]);

    expect(findOnPage(cut, { text: "declined" }).spans[0]?.disappeared).toMatchObject({
      eventId: "C-2",
      truncated: true
    });
  });

  it("finds nothing without a text or a role", () => {
    expect(findOnPage(snapshots, {}).spans).toEqual([]);
  });
});
