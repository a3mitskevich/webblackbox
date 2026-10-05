import { getRelatedTabsAt, TAB_LIFECYCLE_CHANGES, type TabsContext } from "@webblackbox/player-sdk";
import type { RelatedTabChangeKind, RelatedTabInfo, WebBlackboxEvent } from "@webblackbox/protocol";

type TabsBadgeMessages = {
  t: (
    key: "summaryParallelTabs" | "summaryParallelTabsDetail",
    values?: Record<string, string | number>
  ) => string;
};

export type ParallelTabsBadge = {
  text: string;
  title: string;
  /** Event the badge jumps to: the first snapshot, or the first change. */
  eventId: string;
};

/** Session header badge, or null when the archive has no tabs context (older or turned off). */
export function buildParallelTabsBadge(
  context: TabsContext,
  messages: TabsBadgeMessages
): ParallelTabsBadge | null {
  const first = context.snapshots[0] ?? context.changes[0];

  if (!first) {
    return null;
  }

  const { summary } = context;

  return {
    text: messages.t("summaryParallelTabs", { count: summary.distinctTabs }),
    title: messages.t("summaryParallelTabsDetail", {
      max: summary.maxConcurrent,
      start: summary.openAtStart,
      sameOrigin: summary.sameOrigin,
      sameSite: summary.sameSite
    }),
    eventId: first.eventId
  };
}

/** Tab opened, closed or moved: worth a marker on the playback bar. */
export function isTabLifecycleEvent(event: WebBlackboxEvent): boolean {
  if (event.type !== "meta.tabs.change") {
    return false;
  }

  const change = (event.data as { change?: unknown } | null)?.change;
  return typeof change === "string" && TAB_LIFECYCLE_CHANGES.has(change as RelatedTabChangeKind);
}

/** Inspector extras for a selected `meta.tabs.*` event: other tabs of the site open right after it. */
export function buildTabsEventDetails(
  context: TabsContext,
  event: WebBlackboxEvent
): { openTabs: RelatedTabInfo[] } | null {
  if (!event.type.startsWith("meta.tabs.")) {
    return null;
  }

  return { openTabs: getRelatedTabsAt(context, event.mono) };
}

/** The tabs event at (or the nearest before) `mono`, for a clicked tabs marker. */
export function findTabsEventAt(context: TabsContext, mono: number): string | null {
  let found: { eventId: string; mono: number } | null = null;

  for (const entry of [...context.snapshots, ...context.changes]) {
    if (entry.mono <= mono && (!found || entry.mono >= found.mono)) {
      found = entry;
    }
  }

  return found?.eventId ?? null;
}
