import type { RelatedTabInfo, WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { formatTabsContextReport, getRelatedTabsAt, readTabsContext } from "./tabs-context.js";

const INBOX: RelatedTabInfo = {
  tabId: 2,
  windowId: 1,
  relation: "same-origin",
  origin: "https://app.example.com",
  path: "/inbox",
  active: false,
  focused: false,
  incognito: false,
  firstSeenAt: 1_000
};
const ADMIN: RelatedTabInfo = {
  ...INBOX,
  tabId: 3,
  relation: "same-site",
  origin: "https://admin.example.com",
  path: "/users",
  incognito: true
};

let sequence = 0;

function event(type: string, mono: number, data: unknown): WebBlackboxEvent {
  sequence += 1;
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: 1_000 + mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id: `E-${sequence}`,
    data
  };
}

function snapshot(mono: number, tabs: RelatedTabInfo[], reason = "start") {
  return event("meta.tabs.snapshot", mono, {
    reason,
    level: "allow",
    origin: "https://app.example.com",
    site: "example.com",
    tabs
  });
}

function change(mono: number, kind: string, tab: RelatedTabInfo, openCount: number) {
  return event("meta.tabs.change", mono, { change: kind, level: "allow", tab, openCount });
}

const EVENTS = [
  event("meta.config", 0, {}),
  snapshot(10, [INBOX]),
  change(20, "opened", ADMIN, 2),
  change(30, "navigated", { ...ADMIN, path: "/users/7" }, 2),
  change(40, "closed", INBOX, 1),
  change(50, "left", { ...ADMIN, path: "/users/7" }, 0),
  // Untrusted archive data: not a valid tabs change, skipped.
  event("meta.tabs.change", 60, { change: "teleported", tab: INBOX }),
  event("meta.tabs.snapshot", 70, { tabs: "nope" })
];

describe("readTabsContext", () => {
  it("reads snapshots and changes and skips events that fail the schema", () => {
    const context = readTabsContext(EVENTS);

    expect(context.snapshots).toHaveLength(1);
    expect(context.changes.map((entry) => [entry.change, entry.tab.tabId, entry.mono])).toEqual([
      ["opened", 3, 20],
      ["navigated", 3, 30],
      ["closed", 2, 40],
      ["left", 3, 50]
    ]);
  });

  it("summarizes the parallel tabs of the session", () => {
    expect(readTabsContext(EVENTS).summary).toEqual({
      site: "example.com",
      level: "allow",
      openAtStart: 1,
      maxConcurrent: 2,
      distinctTabs: 2,
      sameOrigin: 1,
      sameSite: 1,
      incognito: 1,
      changeCounts: {
        opened: 1,
        entered: 0,
        navigated: 1,
        left: 1,
        closed: 1,
        activated: 0,
        deactivated: 0,
        updated: 0
      }
    });
  });

  it("is empty for archives without tab events", () => {
    const context = readTabsContext([event("meta.config", 0, {})]);

    expect(context.snapshots).toEqual([]);
    expect(context.changes).toEqual([]);
    expect(context.summary).toMatchObject({ openAtStart: 0, maxConcurrent: 0, distinctTabs: 0 });
    expect(context.summary.level).toBeUndefined();
    expect(formatTabsContextReport(context, 10)).toEqual(["- Not recorded"]);
  });

  it("does not count tabs of a later snapshot as open at start", () => {
    const context = readTabsContext([snapshot(10, [INBOX], "profile-change")]);

    expect(context.summary.openAtStart).toBe(0);
    expect(context.summary.maxConcurrent).toBe(1);
  });
});

describe("getRelatedTabsAt", () => {
  it("replays the snapshot and changes up to a time", () => {
    const context = readTabsContext(EVENTS);
    const ids = (mono: number) => getRelatedTabsAt(context, mono).map((tab) => tab.tabId);

    expect(ids(5)).toEqual([]);
    expect(ids(15)).toEqual([2]);
    expect(ids(25)).toEqual([2, 3]);
    expect(getRelatedTabsAt(context, 35).find((tab) => tab.tabId === 3)?.path).toBe("/users/7");
    expect(ids(45)).toEqual([3]);
    expect(ids(1_000)).toEqual([]);
  });
});

describe("formatTabsContextReport", () => {
  it("lists the summary and changes on single lines without markdown from the archive", () => {
    const hostile = { ...ADMIN, path: "/a\n## Injected `code` [link](x)" };
    const lines = formatTabsContextReport(
      readTabsContext([snapshot(10, [INBOX]), change(20, "entered", hostile, 2)]),
      10
    );

    expect(lines[0]).toBe(
      "- Other tabs of example.com open in parallel: 2 at most at once, 1 when recording started"
    );
    expect(lines[1]).toBe("- Tabs seen: 2 (1 same-origin, 1 same-site, 1 incognito)");
    expect(lines[2]).toMatch(/^- E-\d+ @ 20\.00ms tab 3 entered \(same-site\) https:\/\/admin/);
    expect(lines.join("\n")).not.toMatch(/\n## Injected|`|\[link\]/);
  });
});
