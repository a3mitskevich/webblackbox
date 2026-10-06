import {
  RELATED_TAB_CHANGE_KINDS,
  validateEventData,
  type RelatedTabChangeKind,
  type RelatedTabInfo,
  type TabsChangePayload,
  type TabsSnapshotPayload,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

/** A `meta.tabs.snapshot`: every other tab of the recorded site at one moment. */
export type TabsContextSnapshot = TabsSnapshotPayload & {
  eventId: string;
  t: number;
  mono: number;
};

/** A `meta.tabs.change`: one other tab of the site changed. */
export type TabsContextChange = TabsChangePayload & {
  eventId: string;
  t: number;
  mono: number;
};

export type TabsContextSummary = {
  /** Registrable domain of the recorded site (from the latest snapshot). */
  site?: string;
  /** Most detailed level the session recorded (`allow` adds paths and titles). */
  level?: TabsSnapshotPayload["level"];
  /** Other tabs of the site open when recording started. */
  openAtStart: number;
  /** Most other tabs of the site open at the same time. */
  maxConcurrent: number;
  /** Other tabs of the site seen during the session. */
  distinctTabs: number;
  /** Distinct tabs seen on the recorded origin at least once. */
  sameOrigin: number;
  /** Distinct tabs only ever seen on other origins of the site. */
  sameSite: number;
  incognito: number;
  changeCounts: Record<RelatedTabChangeKind, number>;
};

export type TabsContext = {
  snapshots: TabsContextSnapshot[];
  changes: TabsContextChange[];
  summary: TabsContextSummary;
};

/** Changes that open, close or move a tab: shown as timeline markers. */
export const TAB_LIFECYCLE_CHANGES: ReadonlySet<RelatedTabChangeKind> = new Set([
  "opened",
  "entered",
  "navigated",
  "left",
  "closed"
]);

type TimedEntry = TabsContextSnapshot | TabsContextChange;

type SeenTab = { sameOrigin: boolean; incognito: boolean };

/**
 * Other tabs of the recorded site, from the archive's `meta.tabs.*` events. Archive data is
 * untrusted: events failing the protocol schema are skipped. Empty for older archives.
 */
export function readTabsContext(events: readonly WebBlackboxEvent[]): TabsContext {
  const snapshots: TabsContextSnapshot[] = [];
  const changes: TabsContextChange[] = [];

  for (const event of events) {
    if (event.type !== "meta.tabs.snapshot" && event.type !== "meta.tabs.change") {
      continue;
    }

    const parsed = validateEventData(event.type, event.data);

    if (!parsed.success) {
      continue;
    }

    const stamp = { eventId: event.id, t: event.t, mono: event.mono };

    if (event.type === "meta.tabs.snapshot") {
      snapshots.push({ ...(parsed.data as TabsSnapshotPayload), ...stamp });
    } else {
      changes.push({ ...(parsed.data as TabsChangePayload), ...stamp });
    }
  }

  return { snapshots, changes, summary: summarize(snapshots, changes) };
}

/** Other tabs of the site open at `mono`: the latest snapshot replayed with later changes. */
export function getRelatedTabsAt(context: TabsContext, mono: number): RelatedTabInfo[] {
  const open = new Map<number, RelatedTabInfo>();

  for (const entry of mergeByTime(context.snapshots, context.changes)) {
    if (entry.mono > mono) {
      break;
    }

    applyEntry(open, entry);
  }

  return [...open.values()];
}

function summarize(
  snapshots: readonly TabsContextSnapshot[],
  changes: readonly TabsContextChange[]
): TabsContextSummary {
  const open = new Map<number, RelatedTabInfo>();
  const seen = new Map<number, SeenTab>();
  const changeCounts = Object.fromEntries(
    RELATED_TAB_CHANGE_KINDS.map((kind) => [kind, 0])
  ) as Record<RelatedTabChangeKind, number>;
  let maxConcurrent = 0;

  for (const entry of mergeByTime(snapshots, changes)) {
    applyEntry(open, entry);
    maxConcurrent = Math.max(maxConcurrent, open.size);

    for (const tab of "tabs" in entry ? entry.tabs : [entry.tab]) {
      const previous = seen.get(tab.tabId);
      seen.set(tab.tabId, {
        sameOrigin: (previous?.sameOrigin ?? false) || tab.relation === "same-origin",
        incognito: (previous?.incognito ?? false) || tab.incognito
      });
    }

    if ("change" in entry) {
      changeCounts[entry.change] += 1;
    }
  }

  const latest = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const recorded = [...snapshots, ...changes];
  const seenTabs = [...seen.values()];

  return {
    ...(latest ? { site: latest.site } : {}),
    ...(recorded.length > 0
      ? { level: recorded.some((entry) => entry.level === "allow") ? "allow" : "metadata" }
      : {}),
    openAtStart: first?.reason === "start" ? first.tabs.length : 0,
    maxConcurrent,
    distinctTabs: seen.size,
    sameOrigin: seenTabs.filter((tab) => tab.sameOrigin).length,
    sameSite: seenTabs.filter((tab) => !tab.sameOrigin).length,
    incognito: seenTabs.filter((tab) => tab.incognito).length,
    changeCounts
  };
}

function mergeByTime(
  snapshots: readonly TabsContextSnapshot[],
  changes: readonly TabsContextChange[]
): TimedEntry[] {
  return [...snapshots, ...changes].sort((left, right) => left.mono - right.mono);
}

function applyEntry(open: Map<number, RelatedTabInfo>, entry: TimedEntry): void {
  if ("tabs" in entry) {
    open.clear();

    for (const tab of entry.tabs) {
      open.set(tab.tabId, tab);
    }

    return;
  }

  if (entry.change === "closed" || entry.change === "left") {
    open.delete(entry.tab.tabId);
  } else {
    open.set(entry.tab.tabId, entry.tab);
  }
}

const REPORT_TEXT_MAX = 160;

/** Markdown lines of the "Parallel Tabs" bug report section (archive text kept on one line). */
export function formatTabsContextReport(context: TabsContext, maxItems: number): string[] {
  const { summary } = context;

  if (context.snapshots.length === 0 && context.changes.length === 0) {
    return ["- Not recorded"];
  }

  const site = summary.site ? ` of ${reportText(summary.site)}` : "";
  const lines = [
    `- Other tabs${site} open in parallel: ${summary.maxConcurrent} at most at once, ` +
      `${summary.openAtStart} when recording started`,
    `- Tabs seen: ${summary.distinctTabs} (${summary.sameOrigin} same-origin, ` +
      `${summary.sameSite} same-site, ${summary.incognito} incognito)`
  ];
  const changes = context.changes.slice(0, maxItems).map((change) => {
    const location = `${change.tab.origin}${change.tab.path ?? ""}`;
    return (
      `- ${change.eventId} @ ${change.mono.toFixed(2)}ms tab ${change.tab.tabId} ${change.change} ` +
      `(${change.tab.relation}) ${reportText(location)}`
    );
  });

  return [...lines, ...changes];
}

function reportText(value: string): string {
  const text = value
    .replace(/\s+/g, " ")
    .replace(/[`<>[\]]/g, "")
    .trim();
  return text.length > REPORT_TEXT_MAX ? `${text.slice(0, REPORT_TEXT_MAX - 3)}...` : text;
}
