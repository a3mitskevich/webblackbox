import {
  validateEventData,
  type RelatedTabInfo,
  type TabsChangePayload,
  type TabsSnapshotPayload
} from "@webblackbox/protocol";

import { compactText } from "./normalizer-utils.js";
import { recordedPageText, recordedUrl } from "./url-recording.js";

const MAX_PATH_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 512;

export type TabsContextEventType = "meta.tabs.snapshot" | "meta.tabs.change";

/**
 * A parallel-tabs payload from the extension, checked against the strict protocol schema
 * (malformed payloads are dropped) with paths and titles recorded through the session's URL and
 * value-pattern rules, like the recorded tab's own URLs and page text.
 */
export function normalizeTabsContextPayload(
  eventType: TabsContextEventType,
  payload: unknown
): TabsSnapshotPayload | TabsChangePayload | null {
  const parsed = validateEventData(eventType, payload);

  if (!parsed.success) {
    return null;
  }

  if (eventType === "meta.tabs.snapshot") {
    const snapshot = parsed.data as TabsSnapshotPayload;
    return { ...snapshot, tabs: snapshot.tabs.map(recordTab) };
  }

  const change = parsed.data as TabsChangePayload;
  return { ...change, tab: recordTab(change.tab) };
}

function recordTab(tab: RelatedTabInfo): RelatedTabInfo {
  return {
    ...tab,
    ...(tab.path !== undefined
      ? { path: compactText(recordedUrl(tab.path), MAX_PATH_LENGTH) }
      : {}),
    ...(tab.title !== undefined
      ? { title: compactText(recordedPageText(tab.title), MAX_TITLE_LENGTH) }
      : {})
  };
}
