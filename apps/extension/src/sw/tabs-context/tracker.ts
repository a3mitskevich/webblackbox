import type {
  CapturePolicy,
  RelatedTabInfo,
  TabsChangePayload,
  TabsContextLevel,
  TabsSnapshotPayload,
  TabsSnapshotReason
} from "@webblackbox/protocol";

import {
  buildRelatedTab,
  buildTabsChangePayload,
  buildTabsSnapshotPayload,
  diffRelatedTab,
  MAX_RELATED_TABS,
  type ChromeTabLike,
  type RecordedTabsLevel
} from "./related-tabs.js";
import { parseTabLocation, type TabLocation } from "./site.js";

type ChromeEvent<TListener> = {
  addListener(listener: TListener): void;
  removeListener(listener: TListener): void;
};

type TabUpdatedListener = (tabId: number, changeInfo: Record<string, unknown>) => void;
type TabActivatedListener = (activeInfo: { tabId: number; windowId: number }) => void;

/** The slice of `chrome.tabs` / `chrome.windows` the tracker uses. */
export type TabsContextChromeApi = {
  tabs: {
    query(queryInfo: Record<string, never>): Promise<ChromeTabLike[]>;
    get(tabId: number): Promise<ChromeTabLike>;
    onCreated: ChromeEvent<(tab: ChromeTabLike) => void>;
    onUpdated: ChromeEvent<TabUpdatedListener>;
    onRemoved: ChromeEvent<(tabId: number) => void>;
    onActivated: ChromeEvent<TabActivatedListener>;
  };
  windows?: {
    WINDOW_ID_NONE?: number;
    getLastFocused(): Promise<{ id?: number; focused?: boolean }>;
    onFocusChanged: ChromeEvent<(windowId: number) => void>;
  };
};

export type TabsContextEmission =
  | { rawType: "tabs.snapshot"; payload: TabsSnapshotPayload }
  | { rawType: "tabs.change"; payload: TabsChangePayload };

export type TabsContextTrackerOptions = {
  /** Receives every snapshot and change for the session recording `recordedTabId`. */
  emit: (recordedTabId: number, emission: TabsContextEmission) => void;
  now?: () => number;
  debounceMs?: number;
  onError?: (error: unknown) => void;
};

type TrackedSession = {
  recordedTabId: number;
  level: RecordedTabsLevel;
  recorded: TabLocation;
  known: Map<number, RelatedTabInfo>;
  /** Tabs created while the session recorded: their first appearance is `opened`. */
  created: Set<number>;
  /** Set once the snapshot is taken; changes are diffed against it, never before it. */
  snapshotTaken: boolean;
};

/** Collapses the burst of `onUpdated` calls one navigation fires (loading, url, title, complete). */
const DEFAULT_DEBOUNCE_MS = 250;
/** `onUpdated` fields that can change what a session records about a tab. */
const RELEVANT_UPDATE_FIELDS = ["url", "status", "title", "discarded", "frozen"];

/** The session's tabs level: policies written before the category existed mean `metadata`. */
export function resolveTabsContextLevel(policy: CapturePolicy | undefined): TabsContextLevel {
  return policy ? (policy.categories.tabsContext ?? "metadata") : "off";
}

/**
 * Watches other tabs of each recorded site. Chrome listeners are registered only while at least
 * one session tracks tabs, so idle browsing costs nothing. Every event only marks tabs dirty; a
 * debounced flush re-reads them and diffs the result against what each session last recorded.
 */
export class TabsContextTracker {
  private readonly sessions = new Map<number, TrackedSession>();
  private readonly dirty = new Set<number>();
  private readonly removed = new Set<number>();
  private focusedWindowId: number | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listening = false;
  private readonly now: () => number;
  private readonly debounceMs: number;

  public constructor(
    private readonly api: TabsContextChromeApi,
    private readonly options: TabsContextTrackerOptions
  ) {
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Starts (or restarts) tracking for a recorded tab; `off` stops it. Resolves after the snapshot. */
  public startSession(
    recordedTabId: number,
    input: { url: string | undefined; level: TabsContextLevel; reason?: TabsSnapshotReason }
  ): Promise<void> {
    const recorded = parseTabLocation(input.url);

    if (input.level === "off" || !recorded) {
      this.stopSession(recordedTabId);
      return this.queue;
    }

    const session: TrackedSession = {
      recordedTabId,
      level: input.level,
      recorded,
      known: new Map(),
      created: this.sessions.get(recordedTabId)?.created ?? new Set(),
      snapshotTaken: false
    };
    this.sessions.set(recordedTabId, session);
    this.ensureListening();

    return this.enqueue(() => this.takeSnapshot(session, input.reason ?? "start"));
  }

  /**
   * Re-snapshots when the session's level or the recorded tab's origin changed (profile switch,
   * cross-origin navigation); nothing happens otherwise.
   */
  public updateSession(
    recordedTabId: number,
    input: { url?: string; level?: TabsContextLevel }
  ): Promise<void> {
    const session = this.sessions.get(recordedTabId);

    if (!session) {
      return input.level && input.level !== "off" && input.url
        ? this.startSession(recordedTabId, {
            url: input.url,
            level: input.level,
            reason: "profile-change"
          })
        : this.queue;
    }

    const level = input.level ?? session.level;
    // A non-http page (about:blank, an error page) keeps the relations of the last site.
    const recorded = (input.url ? parseTabLocation(input.url) : null) ?? session.recorded;

    if (level === session.level && recorded.origin === session.recorded.origin) {
      return this.queue;
    }

    return this.startSession(recordedTabId, {
      url: recorded.origin,
      level,
      reason: level !== session.level ? "profile-change" : "origin-change"
    });
  }

  public stopSession(recordedTabId: number): void {
    this.sessions.delete(recordedTabId);

    if (this.sessions.size === 0) {
      this.stopListening();
    }
  }

  public isListening(): boolean {
    return this.listening;
  }

  /** Flushes pending changes now and resolves once queued work is done (session stop, tests). */
  public settle(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      return this.enqueue(() => this.flush());
    }

    return this.queue;
  }

  private readonly onCreated = (tab: ChromeTabLike): void => {
    if (typeof tab.id !== "number") {
      return;
    }

    for (const session of this.sessions.values()) {
      session.created.add(tab.id);
    }

    this.markDirty(tab.id);
  };

  private readonly onUpdated: TabUpdatedListener = (tabId, changeInfo) => {
    if (RELEVANT_UPDATE_FIELDS.some((field) => field in changeInfo)) {
      this.markDirty(tabId);
    }
  };

  private readonly onRemoved = (tabId: number): void => {
    this.removed.add(tabId);
    this.markDirty(tabId);
  };

  private readonly onActivated: TabActivatedListener = ({ tabId, windowId }) => {
    // The tab that lost `active` in that window may be a related one.
    this.markKnownTabsDirty((tab) => tab.windowId === windowId);
    this.markDirty(tabId);
  };

  private readonly onFocusChanged = (windowId: number): void => {
    this.focusedWindowId = windowId === this.api.windows?.WINDOW_ID_NONE ? null : windowId;
    this.markKnownTabsDirty(() => true);
    this.scheduleFlush();
  };

  private markKnownTabsDirty(predicate: (tab: RelatedTabInfo) => boolean): void {
    for (const session of this.sessions.values()) {
      for (const tab of session.known.values()) {
        if (predicate(tab)) {
          this.dirty.add(tab.tabId);
        }
      }
    }
  }

  private markDirty(tabId: number): void {
    if (this.sessions.size === 0) {
      return;
    }

    this.dirty.add(tabId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.dirty.size === 0) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueue(() => this.flush());
    }, this.debounceMs);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.options.onError?.(error);
    });
    return this.queue;
  }

  private async takeSnapshot(session: TrackedSession, reason: TabsSnapshotReason): Promise<void> {
    const [tabs] = await Promise.all([this.api.tabs.query({}), this.refreshFocusedWindow()]);

    // A newer start or a stop replaced this session while Chrome answered.
    if (this.sessions.get(session.recordedTabId) !== session) {
      return;
    }

    const now = this.now();

    for (const tab of tabs) {
      const related = this.relate(session, tab, now);

      if (related && session.known.size < MAX_RELATED_TABS) {
        session.known.set(related.tabId, related);
      }
    }

    session.snapshotTaken = true;
    this.options.emit(session.recordedTabId, {
      rawType: "tabs.snapshot",
      payload: buildTabsSnapshotPayload({
        reason,
        level: session.level,
        recorded: session.recorded,
        tabs: [...session.known.values()]
      })
    });
  }

  private async flush(): Promise<void> {
    const tabIds = [...this.dirty];
    const removed = new Set([...this.removed].filter((tabId) => this.dirty.has(tabId)));
    this.dirty.clear();
    this.removed.clear();

    if (this.sessions.size === 0 || tabIds.length === 0) {
      return;
    }

    const tabs = await Promise.all(
      tabIds.map((tabId) => (removed.has(tabId) ? null : this.readTab(tabId)))
    );
    const now = this.now();

    tabIds.forEach((tabId, index) => {
      for (const session of this.sessions.values()) {
        // A session started while this flush waited for Chrome: its snapshot sees the tab.
        if (!session.snapshotTaken) {
          continue;
        }

        this.applyObservation(session, tabId, tabs[index] ?? null, removed.has(tabId), now);
      }
    });
  }

  private applyObservation(
    session: TrackedSession,
    tabId: number,
    tab: ChromeTabLike | null,
    removed: boolean,
    now: number
  ): void {
    const previous = session.known.get(tabId);
    const next = tab ? this.relate(session, tab, now, previous) : null;

    if (next && !previous && session.known.size >= MAX_RELATED_TABS) {
      return;
    }

    const change = diffRelatedTab(previous, next, {
      // A tab that vanished between the event and the flush was closed too.
      removed: removed || tab === null,
      createdDuringSession: session.created.has(tabId),
      level: session.level
    });

    if (next) {
      session.known.set(tabId, next);
    } else {
      session.known.delete(tabId);
    }

    const recordedState = next ?? previous;

    if (!change || !recordedState) {
      return;
    }

    this.options.emit(session.recordedTabId, {
      rawType: "tabs.change",
      payload: buildTabsChangePayload({
        change,
        level: session.level,
        tab: recordedState,
        openCount: session.known.size
      })
    });
  }

  private relate(
    session: TrackedSession,
    tab: ChromeTabLike,
    now: number,
    previous?: RelatedTabInfo
  ): RelatedTabInfo | null {
    return buildRelatedTab(tab, {
      recordedTabId: session.recordedTabId,
      recorded: session.recorded,
      focusedWindowId: this.focusedWindowId,
      now,
      ...(previous ? { previous } : {})
    });
  }

  private async readTab(tabId: number): Promise<ChromeTabLike | null> {
    try {
      return await this.api.tabs.get(tabId);
    } catch {
      // Closed between the event and the flush.
      return null;
    }
  }

  private async refreshFocusedWindow(): Promise<void> {
    try {
      const window = await this.api.windows?.getLastFocused();
      this.focusedWindowId = window?.focused && typeof window.id === "number" ? window.id : null;
    } catch {
      this.focusedWindowId = null;
    }
  }

  private ensureListening(): void {
    if (this.listening) {
      return;
    }

    this.listening = true;
    this.api.tabs.onCreated.addListener(this.onCreated);
    this.api.tabs.onUpdated.addListener(this.onUpdated);
    this.api.tabs.onRemoved.addListener(this.onRemoved);
    this.api.tabs.onActivated.addListener(this.onActivated);
    this.api.windows?.onFocusChanged.addListener(this.onFocusChanged);
  }

  private stopListening(): void {
    if (!this.listening) {
      return;
    }

    this.listening = false;
    this.api.tabs.onCreated.removeListener(this.onCreated);
    this.api.tabs.onUpdated.removeListener(this.onUpdated);
    this.api.tabs.onRemoved.removeListener(this.onRemoved);
    this.api.tabs.onActivated.removeListener(this.onActivated);
    this.api.windows?.onFocusChanged.removeListener(this.onFocusChanged);
    this.dirty.clear();
    this.removed.clear();

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
