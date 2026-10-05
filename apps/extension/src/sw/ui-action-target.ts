export type UiActionTabSources = {
  /** `tabId` carried by the message (the popup always sends one). */
  requestedTabId?: number;
  /** Tab whose content script sent the message, when it came from a page. */
  senderTabId?: number;
  queryActiveTabId: () => Promise<number | undefined>;
  fallbackTabId: () => number | undefined;
};

/**
 * Picks the tab a `ui.start` / `ui.stop` acts on: the requested tab, else the sending tab,
 * else the focused window's active tab, else a tab that is already recording.
 *
 * The sender outranks the active tab: from the service worker, "active tab in the current
 * window" is the last focused window's tab, which need not be the page that asked.
 */
export async function resolveUiActionTabId(
  sources: UiActionTabSources
): Promise<number | undefined> {
  if (isTabId(sources.requestedTabId)) {
    return sources.requestedTabId;
  }

  if (isTabId(sources.senderTabId)) {
    return sources.senderTabId;
  }

  const activeTabId = await sources.queryActiveTabId();

  if (isTabId(activeTabId)) {
    return activeTabId;
  }

  return sources.fallbackTabId();
}

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
