import { describe, expect, it, vi } from "vitest";

import { createRecordedTabWatch } from "./recorded-tab-watch.js";

function createEvent() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
}

const handlers = {
  onTabUpdated: vi.fn(),
  onTabRemoved: vi.fn(),
  onFrameCommitted: vi.fn()
};

describe("recorded tab watch", () => {
  it("listens only while a session is active", () => {
    const chrome = {
      tabs: { onUpdated: createEvent(), onRemoved: createEvent() },
      webNavigation: { onCommitted: createEvent() }
    };
    const watch = createRecordedTabWatch(chrome, handlers);

    watch.sync(false);
    expect(chrome.tabs.onUpdated.addListener).not.toHaveBeenCalled();
    expect(watch.isWatching()).toBe(false);

    watch.sync(true);
    watch.sync(true);
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledWith(handlers.onTabUpdated);
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledWith(handlers.onTabRemoved);
    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledWith(
      handlers.onFrameCommitted
    );
    expect(watch.isWatching()).toBe(true);

    watch.sync(false);
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledWith(handlers.onTabUpdated);
    expect(chrome.tabs.onRemoved.removeListener).toHaveBeenCalledWith(handlers.onTabRemoved);
    expect(chrome.webNavigation.onCommitted.removeListener).toHaveBeenCalledWith(
      handlers.onFrameCommitted
    );
    expect(watch.isWatching()).toBe(false);
  });

  it("works without webNavigation (store-safe build)", () => {
    const chrome = { tabs: { onUpdated: createEvent(), onRemoved: createEvent() } };
    const watch = createRecordedTabWatch(chrome, handlers);

    watch.sync(true);
    watch.sync(false);

    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
  });
});
