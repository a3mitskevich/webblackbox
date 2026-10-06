import uFuzzy from "@leeoniya/ufuzzy";

import type { ArchiveModel } from "./archive-model.js";

/** Results per group in the command palette. */
export const PALETTE_RESULT_LIMIT = 30;
/** Above this many prefiltered matches uFuzzy skips the costly ranking and keeps time order. */
const RANK_LIMIT = 1_000;

export type PaletteMatches = {
  /** Event ids, best first; an exact event id comes first. */
  eventIds: string[];
  /** Request ids, best first. */
  reqIds: string[];
};

const fuzzy = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d'#./:_-]+",
  intraChars: "[\\p{L}\\d'#./:_-]"
});

const requestHaystacks = new WeakMap<ArchiveModel, string[]>();

function requestHaystack(model: ArchiveModel): string[] {
  let haystack = requestHaystacks.get(model);

  if (!haystack) {
    haystack = model.waterfall.map((entry) =>
      `${entry.reqId} ${entry.method} ${entry.url} ${entry.status ?? ""}`.toLowerCase()
    );
    requestHaystacks.set(model, haystack);
  }

  return haystack;
}

/** Matching indexes, ranked when there are few enough to rank. */
function rank(haystack: readonly string[], needle: string, limit: number): number[] {
  const idxs = fuzzy.filter(haystack as string[], needle);

  if (!idxs || idxs.length === 0) {
    return [];
  }

  if (idxs.length > RANK_LIMIT) {
    return idxs.slice(0, limit);
  }

  const info = fuzzy.info(idxs, haystack as string[], needle);
  return fuzzy
    .sort(info, haystack as string[], needle)
    .slice(0, limit)
    .map((order) => info.idx[order] as number);
}

/**
 * "Search everything" (PROPOSAL §4, `Ctrl+K`): events by id, type, URL, text and selector (their
 * recorded data), and requests by method, URL and status, ranked by uFuzzy.
 */
export function searchPalette(
  model: ArchiveModel,
  query: string,
  limit: number = PALETTE_RESULT_LIMIT
): PaletteMatches {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return { eventIds: [], reqIds: [] };
  }

  const exact = model.eventById.has(query.trim()) ? [query.trim()] : [];
  const eventIds = rank(model.eventSearchText, needle, limit)
    .map((index) => model.events[index]?.id)
    .filter((id): id is string => id !== undefined && !exact.includes(id));
  const reqIds = rank(requestHaystack(model), needle, limit)
    .map((index) => model.waterfall[index]?.reqId)
    .filter((id): id is string => id !== undefined);

  return { eventIds: [...exact, ...eventIds].slice(0, limit), reqIds };
}
