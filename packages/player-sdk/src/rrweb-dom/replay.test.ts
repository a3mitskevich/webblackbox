import { describe, expect, it } from "vitest";

import {
  click,
  documentNode,
  el,
  fullSnapshot,
  input,
  loadRrwebFixture,
  meta,
  mutation,
  rrwebBatch,
  text
} from "../test-support/rrweb-fixtures.js";
import { captureDomView } from "./diff.js";
import { RrwebDomReplay } from "./index.js";
import { renderDomSubtree } from "./render.js";
import { querySelectorAll } from "./selector.js";
import { DOM_TREE_MAX_NODES } from "./tree.js";

const T0 = 1_000_000;

function syntheticReplay(): RrwebDomReplay {
  return RrwebDomReplay.fromEvents([
    rrwebBatch(T0, [
      meta(5_000),
      fullSnapshot(5_000, documentNode([el(10, "button", { id: "save" }, [text(11, "Save")])]))
    ]),
    rrwebBatch(T0 + 100, [
      click(9_000, 10, 40, 20),
      mutation(9_050, {
        adds: [
          { parentId: 7, nextId: null, node: el(20, "p", { role: "status" }, [text(21, "Saved")]) }
        ]
      })
    ]),
    rrwebBatch(T0 + 500, [
      mutation(9_500, { texts: [{ id: 21, value: "Saved!" }] }),
      input(9_600, 10, "ignored for buttons but recorded")
    ]),
    // A lite summary of the agent's own capture is not an rrweb event.
    { ...rrwebBatch(T0 + 600, []), data: { schema: "rrweb-lite/v1", event: {} } }
  ]);
}

describe("RrwebDomReplay (synthetic)", () => {
  it("places events on the archive clock by their offset in the batch", () => {
    const replay = syntheticReplay();
    const monos = replay.timeline.entries.map((entry) => entry.mono);

    expect(monos).toEqual([T0, T0, T0 + 100, T0 + 150, T0 + 500, T0 + 600]);
    expect(replay.clicks).toEqual([
      { mono: T0 + 100, nodeId: 10, kind: "click", x: 40, y: 20, batchEventId: expect.any(String) }
    ]);
  });

  it("rebuilds the DOM at any moment, forward and back", () => {
    const replay = syntheticReplay();

    expect(replay.domAt(T0 - 1)).toBeNull();
    expect(replay.domAt(T0 + 120)?.tree.has(20)).toBe(false);

    const later = replay.domAt(T0 + 550)!;
    expect(later.tree.get(21)?.text).toBe("Saved!");
    expect(later).toMatchObject({
      snapshotMono: T0,
      appliedMono: T0 + 500,
      href: "https://app.test/orders",
      viewport: { width: 1280, height: 720 },
      truncated: false
    });

    // Back in time: rebuilt from the snapshot.
    const earlier = replay.domAt(T0 + 160)!;
    expect(earlier.tree.get(21)?.text).toBe("Saved");
    expect(replay.domAt(T0 + 1_000)?.tree.get(10)?.value).toBe("ignored for buttons but recorded");
  });

  it("diffs two moments", () => {
    const diff = syntheticReplay().diff(T0 + 600, T0)!;

    expect(diff.added.map((change) => change.label)).toEqual(["p"]);
    expect(syntheticReplay().diff(T0 - 10, T0)).toBeNull();
  });

  it("finds the click and the input of an action by time (and point)", () => {
    const replay = syntheticReplay();

    expect(replay.findClick(T0 + 300)?.nodeId).toBe(10);
    expect(replay.findClick(T0 + 5_000)).toBeNull();
    expect(replay.findInput(T0 + 700)?.nodeId).toBe(10);
    expect(replay.findInput(T0 + 10_000)).toBeNull();
  });
});

describe("RrwebDomReplay on a real recording (realistic site, Lite + Default)", () => {
  const events = loadRrwebFixture("realistic-site-lite");
  const replay = RrwebDomReplay.fromEvents(events);
  const userClicks = events.filter((event) => event.type === "user.click");

  it("resolves every recorded click to the element that was clicked", () => {
    expect(replay.hasRecording).toBe(true);
    expect(userClicks).toHaveLength(13);

    for (const userClick of userClicks) {
      const data = userClick.data as { x: number; y: number };
      const rrwebClick = replay.findClick(userClick.mono, data);
      expect(rrwebClick, userClick.id).not.toBeNull();
      const node = replay.domAt(rrwebClick!.mono)!.tree.get(rrwebClick!.nodeId)!;
      // The harness tags each click target (`data-measure-click`), text is masked (Default).
      expect(node.attributes["data-measure-click"]).toMatch(/^[01]$/);
      expect(["h1", "button"]).toContain(node.tagName);
    }
  });

  it("serves the page as compact HTML and answers selectors", () => {
    const end = replay.timeline.entries.at(-1)!.mono;
    const state = replay.domAt(end)!;
    const page = renderDomSubtree(state.tree, state.tree.rootId!, { maxBytes: 4_000 });

    expect(state.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/$/);
    expect(page.content).toContain('<button wb-id="16" id="refresh" type="button"');
    expect(querySelectorAll(state.tree, state.tree.rootId!, "button#refresh", 5)).toEqual([16]);
  });

  it("gives the same DOM moving forward as rebuilding from the snapshot", () => {
    const moments = replay.timeline.entries.map((entry) => entry.mono);
    const middle = moments[Math.floor(moments.length / 2)]!;
    replay.domAt(moments[1]!);
    const forward = captureDomView(replay.domAt(middle)!.tree);
    const fresh = captureDomView(RrwebDomReplay.fromEvents(events).domAt(middle)!.tree);

    expect([...forward.nodes.keys()]).toEqual([...fresh.nodes.keys()]);
    expect([...forward.nodes.values()]).toEqual([...fresh.nodes.values()]);
  });
});

describe("RrwebDomReplay on a real recording (heavy SPA, pressure mode)", () => {
  const events = loadRrwebFixture("heavy-spa-600-lite");
  const replay = RrwebDomReplay.fromEvents(events);
  const { timeline } = replay;

  it("knows the pressure gaps and the snapshots that close them", () => {
    expect(timeline.fullSnapshots).toHaveLength(3);
    expect(timeline.states.map((entry) => entry.state)).toEqual([
      { status: "paused", reason: "mutation-size" },
      { status: "resumed" },
      { status: "paused", reason: "mutation-size" },
      { status: "resumed" },
      { status: "paused", reason: "mutation-size" }
    ]);

    const firstPause = timeline.states[0]!;
    const inGap = replay.domAt(firstPause.mono + 1)!;
    expect(inGap.gap?.state.status).toBe("paused");

    const secondSnapshot = timeline.entries[timeline.fullSnapshots[1]!]!;
    expect(replay.domAt(secondSnapshot.mono)!.gap).toBeUndefined();
  });

  it("rebuilds every moment within bounded time and size", () => {
    const started = performance.now();

    for (const entry of timeline.entries.slice(timeline.fullSnapshots[0])) {
      const state = replay.domAt(entry.mono)!;
      expect(state.tree.size).toBeLessThan(DOM_TREE_MAX_NODES);
      expect(state.truncated).toBe(false);
    }

    // ~6k-node page, 3 full snapshots; generous for shared CI runners.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("resolves the recorded clicks to the route and row buttons", () => {
    const targets = replay.clicks.map((entry) => {
      const node = replay.domAt(entry.mono)!.tree.get(entry.nodeId)!;
      return node.attributes.id;
    });

    expect(targets).toEqual(["nav-1", "act-12", "nav-2", "nav-0"]);
  });

  it("diffs across a resume by structure (rrweb restarted with new ids)", () => {
    const before = timeline.entries[timeline.fullSnapshots[0]!]!.mono;
    const after = timeline.entries[timeline.fullSnapshots[1]!]!.mono;
    const diff = replay.diff(before, after)!;

    expect(diff.matchedBy).toBe("path");
    expect(diff.attributes.some((change) => change.path.startsWith("html > body"))).toBe(true);
  });
});

describe("recorder states on the timeline", () => {
  it("ends a gap at the next full snapshot, even without a resumed state (a new page)", () => {
    const replay = RrwebDomReplay.fromEvents([
      rrwebBatch(T0, [meta(1), fullSnapshot(1, documentNode([]))]),
      rrwebBatch(T0 + 100, [], { status: "disabled", reason: "node-limit", nodes: 30_000 }),
      rrwebBatch(T0 + 900, [meta(9), fullSnapshot(9, documentNode([], "Next page"))])
    ]);

    expect(replay.timeline.states).toEqual([
      {
        mono: T0 + 100,
        state: { status: "disabled", reason: "node-limit", nodes: 30_000 },
        batchEventId: expect.any(String)
      }
    ]);
    expect(replay.domAt(T0 + 500)?.gap?.state.status).toBe("disabled");
    expect(replay.domAt(T0 + 900)?.gap).toBeUndefined();
    expect(replay.domAt(T0 + 900)?.snapshotMono).toBe(T0 + 900);
  });

  it("dates a pause at the last event of its batch", () => {
    const replay = RrwebDomReplay.fromEvents([
      rrwebBatch(T0, [meta(1), fullSnapshot(1, documentNode([]))]),
      rrwebBatch(T0 + 100, [mutation(50, { texts: [] }), mutation(80, { texts: [] })], {
        status: "paused",
        reason: "mutation-cost",
        costMs: 41
      })
    ]);

    expect(replay.timeline.states[0]?.mono).toBe(T0 + 130);
    expect(replay.domAt(T0 + 120)?.gap).toBeUndefined();
    expect(replay.domAt(T0 + 130)?.gap?.state).toEqual({
      status: "paused",
      reason: "mutation-cost",
      costMs: 41
    });
  });
});
