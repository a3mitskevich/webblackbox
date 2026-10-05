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

/** Log rows that match the shared text filter (key, value, area, operation). */
export function filterStorageChanges(
  changes: readonly StorageChange[],
  query: string
): StorageChange[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [...changes];
  }

  return changes.filter((change) =>
    [change.area, change.op, change.key ?? "", change.value ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
}

/** Whether a key/value row matches the shared text filter. */
export function matchesQuery(query: string, ...parts: readonly (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || parts.some((part) => part?.toLowerCase().includes(needle));
}
