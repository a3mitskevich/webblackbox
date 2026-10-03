import type { SessionListItem } from "../shared/messages.js";

/** Pure helpers for the sessions page: ordering, filtering and form parsing. */

export type SessionStatusFilter = "all" | "live" | "stopped";

export type SessionFilters = {
  query: string;
  status: SessionStatusFilter;
  /** Profile name, or "" for any. */
  profile: string;
  errorsOnly: boolean;
};

export const EMPTY_FILTERS: SessionFilters = {
  query: "",
  status: "all",
  profile: "",
  errorsOnly: false
};

const MAX_TAGS = 12;
const MAX_NOTE_LENGTH = 500;
const SHORT_SID_LENGTH = 18;

/** Live sessions first, then newest first. */
export function orderSessions(sessions: readonly SessionListItem[]): SessionListItem[] {
  return [...sessions].sort(
    (left, right) => Number(right.active) - Number(left.active) || right.startedAt - left.startedAt
  );
}

export function filterSessions(
  sessions: readonly SessionListItem[],
  filters: SessionFilters
): SessionListItem[] {
  const needle = filters.query.trim().toLowerCase();

  return orderSessions(sessions).filter((session) => {
    if (filters.status === "live" && !session.active) {
      return false;
    }

    if (filters.status === "stopped" && session.active) {
      return false;
    }

    if (filters.profile && session.profileName !== filters.profile) {
      return false;
    }

    if (filters.errorsOnly && (session.errorCount ?? 0) === 0) {
      return false;
    }

    if (!needle) {
      return true;
    }

    return [session.title, session.url, session.note, session.sid, ...(session.tags ?? [])]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(needle));
  });
}

/** Profile names present in the list, for the filter. */
export function listProfileNames(sessions: readonly SessionListItem[]): string[] {
  return [
    ...new Set(
      sessions
        .map((session) => session.profileName)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    )
  ].sort((left, right) => left.localeCompare(right));
}

export type SessionPage = { primary: string; secondary: string };

/** Title (or host + path) and the host + path of the recorded page. */
export function describeSessionPage(session: SessionListItem, fallbackTitle: string): SessionPage {
  const title = typeof session.title === "string" ? session.title.trim() : "";
  const rawUrl = typeof session.url === "string" ? session.url.trim() : "";

  if (!rawUrl) {
    return { primary: title || fallbackTitle, secondary: `tab:${session.tabId}` };
  }

  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.length > 1 ? parsed.pathname : "/";
    return { primary: title || `${parsed.host}${path}`, secondary: `${parsed.host}${path}` };
  } catch {
    return { primary: title || rawUrl, secondary: rawUrl };
  }
}

export function shortenSessionId(sid: string): string {
  return sid.length <= SHORT_SID_LENGTH ? sid : `${sid.slice(0, 9)}...${sid.slice(-6)}`;
}

export function parseTagInput(value: string): string[] {
  const tags: string[] = [];

  for (const fragment of value.split(",")) {
    const tag = fragment.trim();

    if (tag && !tags.includes(tag)) {
      tags.push(tag);
    }

    if (tags.length >= MAX_TAGS) {
      break;
    }
  }

  return tags;
}

export function normalizeNoteInput(value: string): string | undefined {
  const normalized = value.trim();
  return normalized ? normalized.slice(0, MAX_NOTE_LENGTH) : undefined;
}
