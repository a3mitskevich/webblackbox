import {
  TABS_CONTEXT_LIMITS,
  type RelatedTabChangeKind,
  type RelatedTabInfo,
  type TabsChangePayload,
  type TabsSnapshotPayload,
  type TabsSnapshotReason
} from "@webblackbox/protocol";

import { parseTabLocation, relateTabLocation, type TabLocation } from "./site.js";

/** The fields of a `chrome.tabs.Tab` the tracker reads. */
export type ChromeTabLike = {
  id?: number;
  windowId?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  incognito?: boolean;
  discarded?: boolean;
  frozen?: boolean;
  openerTabId?: number;
  lastAccessed?: number;
};

export type RecordedTabsLevel = TabsSnapshotPayload["level"];

/** Upper bound of related tabs in one snapshot (the protocol schema limit). */
export const MAX_RELATED_TABS = TABS_CONTEXT_LIMITS.maxTabs;

export type RelatedTabContext = {
  recordedTabId: number;
  recorded: TabLocation;
  focusedWindowId: number | null;
  now: number;
  /** The tab's state before this observation, if it was already on the site. */
  previous?: RelatedTabInfo;
};

/**
 * A tab's related state, with path and title (cut to the session level only when emitted), or
 * null when it is the recorded tab, not http(s), or another site. A tab still loading counts
 * with the URL it is navigating to.
 */
export function buildRelatedTab(
  tab: ChromeTabLike,
  context: RelatedTabContext
): RelatedTabInfo | null {
  if (typeof tab.id !== "number" || tab.id < 0 || tab.id === context.recordedTabId) {
    return null;
  }

  const location = parseTabLocation(tab.url || tab.pendingUrl);
  const relation = location ? relateTabLocation(context.recorded, location) : null;

  if (!location || !relation) {
    return null;
  }

  const active = tab.active === true;
  const windowId = typeof tab.windowId === "number" ? tab.windowId : -1;
  const title = tab.title?.trim().slice(0, TABS_CONTEXT_LIMITS.maxTitleLength);

  return {
    tabId: tab.id,
    windowId,
    relation,
    origin: location.origin,
    // The strict schema drops a whole payload over its bounds, so long URLs are cut here.
    path: location.path.slice(0, TABS_CONTEXT_LIMITS.maxPathLength),
    ...(title ? { title } : {}),
    active,
    focused: active && context.focusedWindowId !== null && windowId === context.focusedWindowId,
    incognito: tab.incognito === true,
    ...(typeof tab.discarded === "boolean" ? { discarded: tab.discarded } : {}),
    ...(typeof tab.frozen === "boolean" ? { frozen: tab.frozen } : {}),
    ...(typeof tab.openerTabId === "number" && tab.openerTabId >= 0
      ? { openerTabId: tab.openerTabId }
      : {}),
    firstSeenAt: context.previous?.firstSeenAt ?? context.now,
    ...(typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed)
      ? { lastAccessed: tab.lastAccessed }
      : {})
  };
}

/**
 * The change between two observations of one tab, or null when nothing the session records
 * changed. Navigations win over focus changes, focus over other flags; title changes only count
 * when titles are recorded.
 */
export function diffRelatedTab(
  previous: RelatedTabInfo | undefined,
  next: RelatedTabInfo | null,
  context: { removed: boolean; createdDuringSession: boolean; level: RecordedTabsLevel }
): RelatedTabChangeKind | null {
  if (!previous) {
    return next ? (context.createdDuringSession ? "opened" : "entered") : null;
  }

  if (!next) {
    return context.removed ? "closed" : "left";
  }

  if (
    previous.origin !== next.origin ||
    previous.relation !== next.relation ||
    previous.path !== next.path
  ) {
    return "navigated";
  }

  if (previous.focused !== next.focused) {
    return next.focused ? "activated" : "deactivated";
  }

  const titleChanged = context.level === "allow" && previous.title !== next.title;

  return titleChanged ||
    previous.active !== next.active ||
    previous.discarded !== next.discarded ||
    previous.frozen !== next.frozen
    ? "updated"
    : null;
}

/** A related tab as the session level records it: paths and titles only at `allow`. */
export function toRecordedTab(tab: RelatedTabInfo, level: RecordedTabsLevel): RelatedTabInfo {
  if (level === "allow") {
    return { ...tab };
  }

  return Object.fromEntries(
    Object.entries(tab).filter(([key]) => key !== "path" && key !== "title")
  ) as RelatedTabInfo;
}

export function buildTabsSnapshotPayload(input: {
  reason: TabsSnapshotReason;
  level: RecordedTabsLevel;
  recorded: TabLocation;
  tabs: readonly RelatedTabInfo[];
}): TabsSnapshotPayload {
  return {
    reason: input.reason,
    level: input.level,
    origin: input.recorded.origin,
    site: input.recorded.site,
    tabs: input.tabs.slice(0, MAX_RELATED_TABS).map((tab) => toRecordedTab(tab, input.level))
  };
}

export function buildTabsChangePayload(input: {
  change: RelatedTabChangeKind;
  level: RecordedTabsLevel;
  tab: RelatedTabInfo;
  openCount: number;
}): TabsChangePayload {
  return {
    change: input.change,
    level: input.level,
    tab: toRecordedTab(input.tab, input.level),
    openCount: input.openCount
  };
}
