import type { CapturePolicy } from "@webblackbox/protocol";

import {
  capStorageValue,
  STORAGE_SNAPSHOT_MAX_ITEMS,
  STORAGE_SNAPSHOT_MAX_VALUE_CHARS
} from "./capture-scope.js";
import { readIndexedDbSnapshot } from "./indexeddb-snapshot.js";

type CaptureCategories = CapturePolicy["categories"];

/** `cookieSnapshot` payload of `document.cookie`; values are listed only at the `allow` level. */
export function buildCookieSnapshotPayload(
  reason: string,
  level: CaptureCategories["cookies"]
): Record<string, unknown> {
  const cookies = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // A cookie without `=` is a bare value, not a name: it is counted but never listed.
  const names = cookies
    .filter((entry) => entry.includes("="))
    .map((entry) => entry.split("=")[0]?.trim() ?? "");

  if (level === "allow") {
    // `cookies` (name/value records) so the recorder's cookie-name rules can mask values.
    const listed = cookies
      .filter((entry) => entry.includes("="))
      .slice(0, STORAGE_SNAPSHOT_MAX_ITEMS);
    return {
      reason,
      count: cookies.length,
      mode: "allow",
      redacted: false,
      truncated: cookies.length > listed.length,
      cookies: listed.map((entry) => {
        const separator = entry.indexOf("=");
        return {
          name: entry.slice(0, separator).trim(),
          ...capStorageValue(entry.slice(separator + 1))
        };
      })
    };
  }

  const showsNames = level === "names-only";

  return {
    reason,
    count: cookies.length,
    mode: showsNames ? "names-only" : "counts-only",
    redacted: true,
    ...(showsNames
      ? {
          names: names.slice(0, STORAGE_SNAPSHOT_MAX_ITEMS),
          truncated: names.length > STORAGE_SNAPSHOT_MAX_ITEMS
        }
      : {})
  };
}

/** `localStorageSnapshot` payload at the profile's storage level (`count` read by the caller). */
export function buildLocalStorageSnapshotPayload(
  reason: string,
  level: CaptureCategories["storage"],
  count: number
): Record<string, unknown> {
  if (level !== "names-only" && level !== "lengths-only" && level !== "allow") {
    return {
      reason,
      count,
      truncated: false,
      mode: "counts-only",
      redacted: true
    };
  }

  const keys = readStorageKeys(localStorage, STORAGE_SNAPSHOT_MAX_ITEMS);
  let truncated = count > keys.length;
  let budget = STORAGE_SNAPSHOT_MAX_VALUE_CHARS;
  const details: Record<string, unknown> = {};

  if (level === "names-only") {
    details.keys = keys;
  } else if (level === "lengths-only") {
    details.lengths = keys.map((key) => (localStorage.getItem(key) ?? "").length);
  } else {
    details.entries = keys.flatMap((key) => {
      const value = localStorage.getItem(key) ?? "";

      if (budget <= 0) {
        truncated = true;
        return [];
      }

      const entry = { key, valueLength: value.length, ...capStorageValue(value) };
      budget -= entry.value.length;
      return [entry];
    });
  }

  // Values go through the recorder's redactor (sensitive key names mask their values).
  return {
    reason,
    count,
    truncated,
    mode: level,
    redacted: level !== "allow",
    ...details
  };
}

type IndexedDbSnapshotHost = {
  /** The profile's IndexedDB level, read when it is needed. */
  level: () => CaptureCategories["indexedDb"];
  isRecording: () => boolean;
  emit: (payload: Record<string, unknown>) => void;
};

/** Reads the page's IndexedDB databases and emits one `indexedDbSnapshot` payload. */
export async function captureIndexedDbSnapshot(
  reason: string,
  host: IndexedDbSnapshotHost
): Promise<void> {
  const rows = await indexedDB.databases();

  if (host.level() === "allow") {
    const snapshot = await readIndexedDbSnapshot(indexedDB, rows);

    if (!host.isRecording()) {
      return;
    }

    host.emit({
      reason,
      count: rows.length,
      mode: "allow",
      redacted: false,
      truncated: snapshot.truncated,
      databaseNames: snapshot.databases.map((database) => database.name),
      databases: snapshot.databases
    });
    return;
  }

  const showsNames = host.level() === "names-only";
  const names = rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string")
    .slice(0, STORAGE_SNAPSHOT_MAX_ITEMS);

  host.emit({
    reason,
    count: rows.length,
    mode: showsNames ? "names-only" : "counts-only",
    redacted: true,
    truncated: showsNames && rows.length > names.length,
    ...(showsNames ? { databaseNames: names } : {})
  });
}

function readStorageKeys(storage: Storage, maxItems: number): string[] {
  const keys: string[] = [];

  for (let index = 0; index < storage.length && keys.length < maxItems; index += 1) {
    const key = storage.key(index);

    if (key !== null) {
      keys.push(key);
    }
  }

  return keys;
}
