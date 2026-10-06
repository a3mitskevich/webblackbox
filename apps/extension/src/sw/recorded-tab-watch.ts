import type {
  ChromeApi,
  FrameCommittedListener,
  TabUpdatedListener
} from "../shared/chrome-api.js";

export type RecordedTabWatchHandlers = {
  onTabUpdated: TabUpdatedListener;
  onTabRemoved: (tabId: number) => void;
  onFrameCommitted: FrameCommittedListener;
};

/** Only the events the watch subscribes to. */
type WatchChromeApi = {
  tabs?: Pick<NonNullable<ChromeApi["tabs"]>, "onUpdated" | "onRemoved">;
  webNavigation?: ChromeApi["webNavigation"];
};

export type RecordedTabWatch = {
  /** Adds the listeners while something records and removes them once nothing does. */
  sync(hasActiveSessions: boolean): void;
  isWatching(): boolean;
};

/**
 * Tab and navigation events matter only to tabs being recorded. Listening only while a session
 * is active keeps idle navigations in every other tab from waking the service worker. Sessions
 * do not survive a worker restart (they are stopped on boot), so no top-level registration is
 * needed to wake the worker for them.
 */
export function createRecordedTabWatch(
  chromeApi: WatchChromeApi | null,
  handlers: RecordedTabWatchHandlers
): RecordedTabWatch {
  let watching = false;

  const start = (): void => {
    chromeApi?.tabs?.onUpdated?.addListener(handlers.onTabUpdated);
    chromeApi?.tabs?.onRemoved?.addListener(handlers.onTabRemoved);
    chromeApi?.webNavigation?.onCommitted.addListener(handlers.onFrameCommitted);
    watching = true;
  };

  const stop = (): void => {
    chromeApi?.tabs?.onUpdated?.removeListener?.(handlers.onTabUpdated);
    chromeApi?.tabs?.onRemoved?.removeListener?.(handlers.onTabRemoved);
    chromeApi?.webNavigation?.onCommitted.removeListener(handlers.onFrameCommitted);
    watching = false;
  };

  return {
    sync(hasActiveSessions) {
      if (hasActiveSessions && !watching) {
        start();
      } else if (!hasActiveSessions && watching) {
        stop();
      }
    },
    isWatching() {
      return watching;
    }
  };
}
