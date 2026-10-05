import {
  RELATED_TAB_CHANGE_KINDS,
  RELATED_TAB_RELATIONS,
  TABS_SNAPSHOT_REASONS,
  type RelatedTabChangeKind,
  type RelatedTabInfo,
  type RelatedTabRelation,
  type TabsChangePayload,
  type TabsSnapshotPayload,
  type TabsSnapshotReason
} from "@webblackbox/protocol";

import { asBoolean, asFiniteNumber, asRecord, asString, compactText } from "./normalizer-utils.js";
import { recordedPageText, recordedUrl } from "./url-recording.js";

const MAX_TABS = 500;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_PATH_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 512;

type RecordedTabsLevel = TabsSnapshotPayload["level"];

/** `meta.tabs.snapshot` payload from the extension's raw snapshot (unknown fields dropped). */
export function normalizeTabsSnapshotPayload(payload: unknown): TabsSnapshotPayload | null {
  const row = asRecord(payload);
  const level = readLevel(row?.level);
  const origin = readOrigin(row?.origin);
  const site = readOrigin(row?.site);

  if (!row || !level || !origin || !site) {
    return null;
  }

  const tabs = (Array.isArray(row.tabs) ? row.tabs : [])
    .slice(0, MAX_TABS)
    .map((tab) => normalizeRelatedTab(tab, level))
    .filter((tab): tab is RelatedTabInfo => tab !== null);

  return {
    reason: readEnum<TabsSnapshotReason>(row.reason, TABS_SNAPSHOT_REASONS) ?? "start",
    level,
    origin,
    site,
    tabs
  };
}

/** `meta.tabs.change` payload from the extension's raw change (unknown fields dropped). */
export function normalizeTabsChangePayload(payload: unknown): TabsChangePayload | null {
  const row = asRecord(payload);
  const level = readLevel(row?.level);
  const change = readEnum<RelatedTabChangeKind>(row?.change, RELATED_TAB_CHANGE_KINDS);
  const tab = level ? normalizeRelatedTab(row?.tab, level) : null;
  const openCount = asFiniteNumber(row?.openCount);

  if (!level || !change || !tab) {
    return null;
  }

  return {
    change,
    level,
    tab,
    openCount: openCount !== null && openCount >= 0 ? Math.floor(openCount) : 0
  };
}

/**
 * One related tab. Paths and titles are kept only at the `allow` level and recorded through the
 * session's URL and value-pattern rules, like the recorded tab's own URLs and page text.
 */
function normalizeRelatedTab(value: unknown, level: RecordedTabsLevel): RelatedTabInfo | null {
  const row = asRecord(value);
  const tabId = readTabId(row?.tabId);
  const windowId = asFiniteNumber(row?.windowId);
  const relation = readEnum<RelatedTabRelation>(row?.relation, RELATED_TAB_RELATIONS);
  const origin = readOrigin(row?.origin);
  const firstSeenAt = asFiniteNumber(row?.firstSeenAt);

  if (!row || tabId === null || windowId === null || !relation || !origin || firstSeenAt === null) {
    return null;
  }

  const path = level === "allow" ? readPath(row.path) : undefined;
  const title = level === "allow" ? readTitle(row.title) : undefined;
  const discarded = asBoolean(row.discarded);
  const frozen = asBoolean(row.frozen);
  const openerTabId = readTabId(row.openerTabId);
  const lastAccessed = asFiniteNumber(row.lastAccessed);

  return {
    tabId,
    windowId: Math.trunc(windowId),
    relation,
    origin,
    ...(path !== undefined ? { path } : {}),
    ...(title !== undefined ? { title } : {}),
    active: row.active === true,
    focused: row.focused === true,
    incognito: row.incognito === true,
    ...(discarded !== undefined ? { discarded } : {}),
    ...(frozen !== undefined ? { frozen } : {}),
    ...(openerTabId !== null ? { openerTabId } : {}),
    firstSeenAt,
    ...(lastAccessed !== null ? { lastAccessed } : {})
  };
}

function readLevel(value: unknown): RecordedTabsLevel | null {
  return value === "metadata" || value === "allow" ? value : null;
}

function readEnum<T extends string>(value: unknown, allowed: readonly string[]): T | null {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : null;
}

function readTabId(value: unknown): number | null {
  const id = asFiniteNumber(value);
  return id !== null && Number.isInteger(id) && id >= 0 ? id : null;
}

function readOrigin(value: unknown): string | null {
  const text = asString(value)?.trim();
  return text ? compactText(text, MAX_ORIGIN_LENGTH) : null;
}

function readPath(value: unknown): string | undefined {
  const path = asString(value);
  return path ? compactText(recordedUrl(path), MAX_PATH_LENGTH) : undefined;
}

function readTitle(value: unknown): string | undefined {
  const title = asString(value)?.trim();
  return title ? compactText(recordedPageText(title), MAX_TITLE_LENGTH) : undefined;
}
