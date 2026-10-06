/**
 * The recording a raw event belongs to: the one of the tab it came from. A recording leaves the
 * by-tab map when it stops but still takes its tab's drain, found through the sid the event
 * carries; that sid is trusted only when it names a recording of the same tab, so an event never
 * crosses into another tab's recording.
 */
export function resolveRawEventSession<TSession extends { tabId: number }>(
  rawEvent: { tabId: number; sid?: unknown },
  sessionsByTab: ReadonlyMap<number, TSession>,
  sessionsBySid: ReadonlyMap<string, TSession>
): TSession | undefined {
  const byTab = sessionsByTab.get(rawEvent.tabId);

  if (byTab) {
    return byTab;
  }

  const bySid = typeof rawEvent.sid === "string" ? sessionsBySid.get(rawEvent.sid) : undefined;
  return bySid?.tabId === rawEvent.tabId ? bySid : undefined;
}
