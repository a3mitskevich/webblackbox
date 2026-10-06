import { readTabsContext } from "@webblackbox/player-sdk";
import type { RelatedTabInfo, WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  buildParallelTabsBadge,
  buildTabsEventDetails,
  findTabsEventAt,
  isTabLifecycleEvent
} from "./tabs-context-view.js";

const TAB: RelatedTabInfo = {
  tabId: 9,
  windowId: 1,
  relation: "same-site",
  origin: "https://admin.example.com",
  active: false,
  focused: false,
  incognito: false,
  firstSeenAt: 1
};

function event(id: string, type: string, mono: number, data: unknown): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S",
    tab: 1,
    t: mono,
    mono,
    type: type as WebBlackboxEvent["type"],
    id,
    data
  };
}

const SNAPSHOT = event("E-1", "meta.tabs.snapshot", 10, {
  reason: "start",
  level: "metadata",
  origin: "https://app.example.com",
  site: "example.com",
  tabs: [TAB]
});
const ACTIVATED = event("E-2", "meta.tabs.change", 20, {
  change: "activated",
  level: "metadata",
  tab: { ...TAB, active: true, focused: true },
  openCount: 1
});
const CLOSED = event("E-3", "meta.tabs.change", 30, {
  change: "closed",
  level: "metadata",
  tab: TAB,
  openCount: 0
});
const CLICK = event("E-4", "user.click", 40, {});
const EVENTS = [SNAPSHOT, ACTIVATED, CLOSED, CLICK];

const messages = {
  t: (key: string, values: Record<string, string | number> = {}) =>
    `${key}:${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join(",")}`
};

describe("tabs context view", () => {
  it("builds the session header badge that jumps to the first snapshot", () => {
    expect(buildParallelTabsBadge(readTabsContext(EVENTS), messages)).toEqual({
      text: "summaryParallelTabs:count=1",
      title: "summaryParallelTabsDetail:max=1,start=1,sameOrigin=0,sameSite=1",
      eventId: "E-1"
    });
    expect(buildParallelTabsBadge(readTabsContext([CLICK]), messages)).toBeNull();
  });

  it("marks only tab lifecycle changes on the playback bar", () => {
    expect(EVENTS.map(isTabLifecycleEvent)).toEqual([false, false, true, false]);
  });

  it("lists the other tabs open after a selected tabs event", () => {
    const context = readTabsContext(EVENTS);

    expect(
      buildTabsEventDetails(context, ACTIVATED)?.openTabs.map((tab) => [tab.tabId, tab.focused])
    ).toEqual([[9, true]]);
    expect(buildTabsEventDetails(context, CLOSED)?.openTabs).toEqual([]);
    expect(buildTabsEventDetails(context, CLICK)).toBeNull();
  });

  it("finds the tabs event under a clicked marker", () => {
    const context = readTabsContext(EVENTS);

    expect(findTabsEventAt(context, 30)).toBe("E-3");
    expect(findTabsEventAt(context, 25)).toBe("E-2");
    expect(findTabsEventAt(context, 5)).toBeNull();
  });
});
