import {
  buildConsoleEntries,
  countConsoleLevels,
  groupConsoleEntries,
  type ConsoleEntry,
  type ConsoleLevel
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { isConsolePrivacyViolation } from "../../../lib/recording-profile-view.js";
import type { LoadedArchive } from "../../state.js";
import type { ConsoleSlice } from "./slice.js";

/** A console row: an SDK console entry, or a "hidden by the profile" notice. */
export type ConsoleRowEntry = ConsoleEntry & {
  /** A `privacy.violation` that stands for console output the profile kept out. */
  privacyViolation?: true;
};

/** One visible row: the first entry of a group of similar rows (or a single row). */
export type ConsoleRow = {
  entry: ConsoleRowEntry;
  count: number;
  memberIds: readonly string[];
};

export type ConsoleView = {
  rows: ConsoleRow[];
  /** Per level, after the text and third-party filters (the chip counts). */
  levelCounts: Record<ConsoleLevel, number>;
  /** Rows hidden by "Hide third-party". */
  hiddenThirdParty: number;
  total: number;
};

const entriesByArchive = new WeakMap<LoadedArchive, ConsoleRowEntry[]>();
const searchTextByArchive = new WeakMap<LoadedArchive, Map<string, string>>();

/** Console rows of the archive, built once per archive (playback clock, archive order). */
export function selectConsoleEntries(archive: LoadedArchive): ConsoleRowEntry[] {
  const cached = entriesByArchive.get(archive);

  if (cached) {
    return cached;
  }

  const siteOrigin = archive.player.archive.manifest.site.origin;
  const entries = archive.model.consoleSignals.flatMap((event): ConsoleRowEntry[] => {
    const [entry] = buildConsoleEntries([event], { siteOrigin });

    if (entry) {
      return [entry];
    }

    return isConsolePrivacyViolation(event) ? [privacyEntry(event)] : [];
  });

  entriesByArchive.set(archive, entries);
  return entries;
}

/** The rows the list shows for the slice settings and the shared text filter. */
export function buildConsoleView(
  archive: LoadedArchive,
  slice: Pick<ConsoleSlice, "levels" | "groupSimilar" | "hideThirdParty">,
  query: string
): ConsoleView {
  const entries = selectConsoleEntries(archive);
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? entries.filter((entry) => searchText(archive, entry).includes(needle))
    : entries;
  const firstParty = slice.hideThirdParty
    ? matching.filter((entry) => !entry.isThirdParty)
    : matching;
  const levels = new Set(slice.levels);
  const visible =
    levels.size > 0 ? firstParty.filter((entry) => levels.has(entry.level)) : firstParty;
  const rows: ConsoleRow[] = slice.groupSimilar
    ? groupConsoleEntries(visible).map((group) => ({
        entry: group.entry as ConsoleRowEntry,
        count: group.count,
        memberIds: group.memberIds
      }))
    : visible.map((entry) => ({ entry, count: 1, memberIds: [entry.eventId] }));

  return {
    rows,
    levelCounts: countConsoleLevels(firstParty),
    hiddenThirdParty: matching.length - firstParty.length,
    total: entries.length
  };
}

/** Errors in the archive (the rail tab count). */
export function countConsoleErrors(archive: LoadedArchive): number {
  return selectConsoleEntries(archive).filter((entry) => entry.level === "error").length;
}

/** The request a console row is about, when the archive holds it. */
export function findRelatedRequestId(archive: LoadedArchive, entry: ConsoleEntry): string | null {
  return entry.reqId && archive.model.waterfallByReqId.has(entry.reqId) ? entry.reqId : null;
}

/** `path/file.ts:57` of a location URL (origin and query dropped), for the row's right column. */
export function describeLocation(url: string, line?: number, column?: number): string {
  const path = shortPath(url);
  return line === undefined ? path : `${path}:${line}${column === undefined ? "" : `:${column}`}`;
}

/** A script or source URL without origin and query: `/static/js/main.js`, `src/live/a.ts`. */
export function shortPath(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.pathname || url;
    }

    // Bundler namespaces (`webpack://app/src/a.ts`): the project-relative path.
    return parsed.protocol === "webpack:" || parsed.protocol === "vite:"
      ? parsed.pathname.replace(/^\/+(\.\/)?/u, "") || url
      : url;
  } catch {
    return url;
  }
}

function privacyEntry(event: WebBlackboxEvent): ConsoleRowEntry {
  return {
    eventId: event.id,
    mono: event.mono,
    level: "warn",
    kind: "other",
    message: event.type,
    location: null,
    isThirdParty: false,
    groupKey: `privacy\u0000${event.id}`,
    hasStack: false,
    privacyViolation: true
  };
}

function searchText(archive: LoadedArchive, entry: ConsoleRowEntry): string {
  let texts = searchTextByArchive.get(archive);

  if (!texts) {
    texts = new Map();
    searchTextByArchive.set(archive, texts);
  }

  const cached = texts.get(entry.eventId);

  if (cached !== undefined) {
    return cached;
  }

  const text = [entry.message, entry.location?.url ?? "", entry.reqId ?? "", entry.source ?? ""]
    .join(" ")
    .toLowerCase();
  texts.set(entry.eventId, text);
  return text;
}
