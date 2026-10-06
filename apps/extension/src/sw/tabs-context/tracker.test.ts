import { TABS_CONTEXT_LIMITS, validateEventData } from "@webblackbox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChromeTabLike } from "./related-tabs.js";
import {
  TabsContextTracker,
  type TabsContextChromeApi,
  type TabsContextEmission
} from "./tracker.js";

const RECORDED_TAB = 1;
const RECORDED_URL = "https://app.example.com/checkout";
const NOW = 1_700_000_000_000;

type Listener = (...args: never[]) => void;

function chromeEvent() {
  const listeners = new Set<Listener>();

  return {
    listeners,
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    fire: (...args: unknown[]) => {
      for (const listener of listeners) {
        (listener as (...values: unknown[]) => void)(...args);
      }
    }
  };
}

function createFakeChrome(initialTabs: ChromeTabLike[]) {
  const tabs = new Map(initialTabs.map((tab) => [tab.id ?? -1, { ...tab }]));
  const events = {
    onCreated: chromeEvent(),
    onUpdated: chromeEvent(),
    onRemoved: chromeEvent(),
    onActivated: chromeEvent(),
    onFocusChanged: chromeEvent()
  };
  let focusedWindowId = 1;
  const api = {
    tabs: {
      query: vi.fn(async () => [...tabs.values()].map((tab) => ({ ...tab }))),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);

        if (!tab) {
          throw new Error(`No tab with id: ${tabId}`);
        }

        return { ...tab };
      }),
      onCreated: events.onCreated,
      onUpdated: events.onUpdated,
      onRemoved: events.onRemoved,
      onActivated: events.onActivated
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: vi.fn(async () => ({ id: focusedWindowId, focused: true })),
      onFocusChanged: events.onFocusChanged
    }
  } as unknown as TabsContextChromeApi;

  return {
    api,
    events,
    create(tab: ChromeTabLike) {
      tabs.set(tab.id ?? -1, { ...tab });
      events.onCreated.fire({ ...tab });
    },
    update(tabId: number, patch: Partial<ChromeTabLike>, changeInfo: Record<string, unknown>) {
      tabs.set(tabId, { ...tabs.get(tabId), ...patch });
      events.onUpdated.fire(tabId, changeInfo);
    },
    remove(tabId: number) {
      tabs.delete(tabId);
      events.onRemoved.fire(tabId, { windowId: 1, isWindowClosing: false });
    },
    activate(tabId: number, windowId: number) {
      for (const [id, tab] of tabs) {
        if (tab.windowId === windowId) {
          tabs.set(id, { ...tab, active: id === tabId });
        }
      }
      events.onActivated.fire({ tabId, windowId });
    },
    focus(windowId: number) {
      focusedWindowId = windowId;
      events.onFocusChanged.fire(windowId);
    },
    listenerCount() {
      return Object.values(events).reduce((total, event) => total + event.listeners.size, 0);
    }
  };
}

const INITIAL_TABS: ChromeTabLike[] = [
  { id: RECORDED_TAB, windowId: 1, url: RECORDED_URL, title: "Checkout", active: true },
  {
    id: 2,
    windowId: 1,
    url: "https://app.example.com/cart?coupon=1#top",
    title: "Cart",
    active: false,
    incognito: false,
    discarded: false,
    lastAccessed: NOW - 5_000
  },
  { id: 3, windowId: 2, url: "https://admin.example.com/users", title: "Users", active: true },
  { id: 4, windowId: 2, url: "https://other.test/", title: "Other site", active: false },
  { id: 5, windowId: 1, url: "chrome://newtab/", active: false }
];

function setup(initialTabs = INITIAL_TABS) {
  const chrome = createFakeChrome(initialTabs);
  const emitted: Array<{ tabId: number } & TabsContextEmission> = [];
  const tracker = new TabsContextTracker(chrome.api, {
    emit: (tabId, emission) => emitted.push({ tabId, ...emission }),
    now: () => NOW,
    debounceMs: 50
  });

  return { chrome, tracker, emitted };
}

function changes(emitted: TabsContextEmission[]) {
  return emitted
    .filter((entry) => entry.rawType === "tabs.change")
    .map((entry) => (entry.rawType === "tabs.change" ? entry.payload : null));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TabsContextTracker", () => {
  it("snapshots other tabs of the site without the recorded tab or other sites", async () => {
    const { tracker, emitted } = setup();

    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "allow" });

    expect(emitted).toEqual([
      {
        tabId: RECORDED_TAB,
        rawType: "tabs.snapshot",
        payload: {
          reason: "start",
          level: "allow",
          origin: "https://app.example.com",
          site: "example.com",
          tabs: [
            {
              tabId: 2,
              windowId: 1,
              relation: "same-origin",
              origin: "https://app.example.com",
              path: "/cart?coupon=1",
              title: "Cart",
              active: false,
              focused: false,
              incognito: false,
              discarded: false,
              firstSeenAt: NOW,
              lastAccessed: NOW - 5_000
            },
            {
              tabId: 3,
              windowId: 2,
              relation: "same-site",
              origin: "https://admin.example.com",
              path: "/users",
              title: "Users",
              active: true,
              focused: false,
              incognito: false,
              firstSeenAt: NOW
            }
          ]
        }
      }
    ]);
  });

  it("records only origins and flags at the metadata level", async () => {
    const { tracker, emitted } = setup();

    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    const snapshot = emitted[0];
    expect(snapshot?.rawType).toBe("tabs.snapshot");
    expect(JSON.stringify(snapshot)).not.toMatch(/"path"|"title"|cart|Users/);
  });

  it("does not listen to tabs at all when the category is off or before any session", async () => {
    const { chrome, tracker, emitted } = setup();

    expect(chrome.listenerCount()).toBe(0);
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "off" });

    expect(chrome.listenerCount()).toBe(0);
    expect(emitted).toEqual([]);
    expect(chrome.api.tabs.query).not.toHaveBeenCalled();
  });

  it("emits opened, navigated, left and closed changes, collapsing update bursts", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "allow" });

    chrome.create({ id: 10, windowId: 1, url: "", pendingUrl: "https://app.example.com/new" });
    chrome.update(
      10,
      { url: "https://app.example.com/new", pendingUrl: undefined },
      { status: "loading", url: "https://app.example.com/new" }
    );
    chrome.update(10, { title: "New" }, { title: "New" });
    chrome.update(10, {}, { status: "complete" });
    await vi.advanceTimersByTimeAsync(60);

    chrome.update(3, { url: "https://admin.example.com/users/7" }, { url: "x" });
    chrome.update(10, { url: "https://other.test/elsewhere" }, { url: "x" });
    chrome.update(2, {}, { favIconUrl: "x" });
    await vi.advanceTimersByTimeAsync(60);

    chrome.remove(3);
    await vi.advanceTimersByTimeAsync(60);

    expect(
      changes(emitted).map((change) => [change?.change, change?.tab.tabId, change?.openCount])
    ).toEqual([
      ["opened", 10, 3],
      ["navigated", 3, 3],
      ["left", 10, 2],
      ["closed", 3, 1]
    ]);
    const left = changes(emitted).find((change) => change?.change === "left");
    expect(left?.tab.path).toBe("/new");
    expect(JSON.stringify(emitted)).not.toContain("other.test");
  });

  it("emits entered for an existing tab that navigates onto the site", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    chrome.update(4, { url: "https://example.com/login" }, { url: "https://example.com/login" });
    await vi.advanceTimersByTimeAsync(60);

    expect(changes(emitted)).toEqual([
      {
        change: "entered",
        level: "metadata",
        openCount: 3,
        tab: {
          tabId: 4,
          windowId: 2,
          relation: "same-site",
          origin: "https://example.com",
          active: false,
          focused: false,
          incognito: false,
          firstSeenAt: NOW
        }
      }
    ]);
  });

  it("emits activated and deactivated when the user switches to a related tab and back", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    chrome.activate(2, 1);
    await vi.advanceTimersByTimeAsync(60);
    chrome.activate(RECORDED_TAB, 1);
    await vi.advanceTimersByTimeAsync(60);
    chrome.focus(2);
    await vi.advanceTimersByTimeAsync(60);
    chrome.focus(-1);
    await vi.advanceTimersByTimeAsync(60);

    expect(changes(emitted).map((change) => [change?.change, change?.tab.tabId])).toEqual([
      ["activated", 2],
      ["deactivated", 2],
      ["activated", 3],
      ["deactivated", 3]
    ]);
  });

  it("ignores title changes at the metadata level and reports them at allow", async () => {
    const metadata = setup();
    await metadata.tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });
    metadata.chrome.update(2, { title: "Cart (2)" }, { title: "Cart (2)" });
    await vi.advanceTimersByTimeAsync(60);

    const allow = setup();
    await allow.tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "allow" });
    allow.chrome.update(2, { title: "Cart (2)" }, { title: "Cart (2)" });
    await vi.advanceTimersByTimeAsync(60);

    expect(changes(metadata.emitted)).toEqual([]);
    expect(changes(allow.emitted).map((change) => [change?.change, change?.tab.title])).toEqual([
      ["updated", "Cart (2)"]
    ]);
  });

  it("re-snapshots on a level or origin change and stops listening after the last session", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    await tracker.updateSession(RECORDED_TAB, { url: "https://app.example.com/other" });
    await tracker.updateSession(RECORDED_TAB, { level: "allow" });
    await tracker.updateSession(RECORDED_TAB, { url: "https://admin.example.com/" });

    expect(
      emitted.map((entry) =>
        entry.rawType === "tabs.snapshot"
          ? [entry.payload.reason, entry.payload.level, entry.payload.tabs.map((tab) => tab.tabId)]
          : null
      )
    ).toEqual([
      ["start", "metadata", [2, 3]],
      ["profile-change", "allow", [2, 3]],
      ["origin-change", "allow", [2, 3]]
    ]);
    expect(chrome.listenerCount()).toBe(5);

    await tracker.updateSession(RECORDED_TAB, { level: "off" });
    expect(chrome.listenerCount()).toBe(0);
    expect(tracker.isListening()).toBe(false);

    chrome.remove(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(emitted).toHaveLength(3);
  });

  it("keeps tracking while the recorded tab is on a non-http page", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    await tracker.updateSession(RECORDED_TAB, { url: "about:blank" });
    await tracker.updateSession(RECORDED_TAB, { url: RECORDED_URL });
    chrome.create({ id: 12, windowId: 1, url: "https://app.example.com/help" });
    await vi.advanceTimersByTimeAsync(60);

    expect(tracker.isListening()).toBe(true);
    expect(emitted.map((entry) => entry.rawType)).toEqual(["tabs.snapshot", "tabs.change"]);
    expect(changes(emitted).map((change) => [change?.change, change?.tab.tabId])).toEqual([
      ["opened", 12]
    ]);
  });

  it("reports nothing for a session whose snapshot is still pending", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    chrome.update(4, { url: "https://example.com/login" }, { url: "https://example.com/login" });
    // The flush is queued; the profile switch replaces the session before it runs.
    vi.advanceTimersByTime(60);
    await tracker.updateSession(RECORDED_TAB, { level: "allow" });

    expect(
      emitted.map((entry) =>
        entry.rawType === "tabs.snapshot"
          ? [entry.payload.reason, entry.payload.tabs.map((tab) => tab.tabId)]
          : [entry.payload.change, entry.payload.tab.tabId]
      )
    ).toEqual([
      ["start", [2, 3]],
      ["profile-change", [2, 3, 4]]
    ]);
  });

  it("cuts long paths and titles so the snapshot still passes the protocol schema", async () => {
    const longQuery = "x".repeat(TABS_CONTEXT_LIMITS.maxPathLength + 100);
    const { tracker, emitted } = setup([
      ...INITIAL_TABS,
      {
        id: 6,
        windowId: 1,
        url: `https://app.example.com/sso?SAMLRequest=${longQuery}`,
        title: "t".repeat(TABS_CONTEXT_LIMITS.maxTitleLength + 100),
        active: false
      }
    ]);

    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "allow" });

    const snapshot = emitted[0];
    expect(snapshot?.rawType).toBe("tabs.snapshot");
    expect(validateEventData("meta.tabs.snapshot", snapshot?.payload).success).toBe(true);
    const long = snapshot?.rawType === "tabs.snapshot" ? snapshot.payload.tabs[2] : undefined;
    expect(long?.tabId).toBe(6);
    expect(long?.path).toHaveLength(TABS_CONTEXT_LIMITS.maxPathLength);
    expect(long?.title).toHaveLength(TABS_CONTEXT_LIMITS.maxTitleLength);
  });

  it("flushes pending changes on settle", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });

    chrome.remove(2);
    await tracker.settle();
    tracker.stopSession(RECORDED_TAB);

    expect(changes(emitted).map((change) => change?.change)).toEqual(["closed"]);
  });

  it("keeps sessions of two recorded tabs apart", async () => {
    const { chrome, tracker, emitted } = setup();
    await tracker.startSession(RECORDED_TAB, { url: RECORDED_URL, level: "metadata" });
    await tracker.startSession(4, { url: "https://other.test/", level: "metadata" });

    chrome.create({ id: 11, windowId: 2, url: "https://other.test/b" });
    await vi.advanceTimersByTimeAsync(60);

    expect(emitted.map((entry) => [entry.tabId, entry.rawType])).toEqual([
      [RECORDED_TAB, "tabs.snapshot"],
      [4, "tabs.snapshot"],
      [4, "tabs.change"]
    ]);

    tracker.stopSession(4);
    expect(tracker.isListening()).toBe(true);
  });
});
