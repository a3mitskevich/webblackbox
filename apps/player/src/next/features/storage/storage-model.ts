import {
  buildStorageChanges,
  buildStorageStateAt,
  isStorageEvent,
  type StorageChange,
  type StorageStateAt
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

import type { LoadedArchive } from "../../state.js";

type StorageData = { events: WebBlackboxEvent[]; changes: StorageChange[] };

const dataByArchive = new WeakMap<LoadedArchive, StorageData>();

/** The archive's storage events and their log, built once per archive (playback clock). */
export function selectStorageData(archive: LoadedArchive): StorageData {
  const cached = dataByArchive.get(archive);

  if (cached) {
    return cached;
  }

  const events = archive.model.events.filter(isStorageEvent);
  const data = { events, changes: buildStorageChanges(events) };
  dataByArchive.set(archive, data);
  return data;
}

/** Storage as the page saw it at `mono`. */
export function selectStorageStateAt(archive: LoadedArchive, mono: number): StorageStateAt {
  return buildStorageStateAt(selectStorageData(archive).events, mono);
}

/** Only this much of a value is searched: the filter runs on every keystroke. */
export const MAX_SEARCH_VALUE_CHARS = 8 * 1024;

const haystackByChange = new WeakMap<StorageChange, string>();

/** The lowercased text the filter searches, built once per change. */
function haystackOf(change: StorageChange): string {
  const cached = haystackByChange.get(change);

  if (cached !== undefined) {
    return cached;
  }

  const haystack = [
    change.area,
    change.op,
    change.key ?? "",
    (change.value ?? "").slice(0, MAX_SEARCH_VALUE_CHARS)
  ]
    .join(" ")
    .toLowerCase();
  haystackByChange.set(change, haystack);
  return haystack;
}

/**
 * Log rows that match the shared text filter (key, value, area, operation). Without a query the
 * input array itself comes back (not a copy): callers must not mutate it.
 */
export function filterStorageChanges(changes: StorageChange[], query: string): StorageChange[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return changes;
  }

  return changes.filter((change) => haystackOf(change).includes(needle));
}

/** Hover titles show this much of a key or value (values can be megabytes). */
export const MAX_TITLE_CHARS = 1_000;

/** A `title` attribute for a possibly huge key or value. */
export function capTitle(value: string | undefined): string | undefined {
  return value !== undefined && value.length > MAX_TITLE_CHARS
    ? `${value.slice(0, MAX_TITLE_CHARS)}…`
    : value;
}

/** Whether a key/value row matches the shared text filter. */
export function matchesQuery(query: string, ...parts: readonly (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || parts.some((part) => part?.toLowerCase().includes(needle));
}
