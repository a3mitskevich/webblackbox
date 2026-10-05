import type { Selection, SelectionKind } from "./navigation.js";

/** Rail tabs of the player (PROPOSAL §3); the order is the `1`…`7` keyboard order. */
export const RAIL_TABS = [
  "activity",
  "network",
  "console",
  "realtime",
  "storage",
  "tabs",
  "perf"
] as const;

export type RailTab = (typeof RAIL_TABS)[number];

/** Player state kept in the URL hash: `#t=10.89&sel=req:90080.1706&tab=network`. */
export type HashState = {
  /** Playhead offset from the session start, in ms. */
  offsetMs?: number;
  selection?: Selection;
  tab?: RailTab;
};

const SELECTION_PREFIX: Record<SelectionKind, string> = {
  event: "evt",
  request: "req",
  action: "act"
};

const SELECTION_KIND_BY_PREFIX = new Map<string, SelectionKind>(
  Object.entries(SELECTION_PREFIX).map(([kind, prefix]) => [prefix, kind as SelectionKind])
);

/** Ids come from the archive; longer ones are not linked. */
const MAX_SELECTION_ID_LENGTH = 200;
/** Ten hours: anything later is not a recording offset. */
const MAX_OFFSET_MS = 36_000_000;

export function isRailTab(value: unknown): value is RailTab {
  return typeof value === "string" && (RAIL_TABS as readonly string[]).includes(value);
}

/**
 * Reads the hash; unknown keys and invalid values are ignored (a pasted link is untrusted input).
 */
export function parseHashState(hash: string): HashState {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const state: HashState = {};
  const rawOffset = params.get("t");

  if (rawOffset !== null && /^\d+(\.\d+)?$/.test(rawOffset)) {
    const offsetMs = Math.round(Number(rawOffset) * 1_000);

    if (Number.isFinite(offsetMs) && offsetMs <= MAX_OFFSET_MS) {
      state.offsetMs = offsetMs;
    }
  }

  const selection = parseSelection(params.get("sel"));

  if (selection) {
    state.selection = selection;
  }

  const tab = params.get("tab");

  if (isRailTab(tab)) {
    state.tab = tab;
  }

  return state;
}

/** `t` with two decimals, then `sel` and `tab`; empty state gives an empty string. */
export function serializeHashState(state: HashState): string {
  const parts: string[] = [];

  if (state.offsetMs !== undefined && Number.isFinite(state.offsetMs) && state.offsetMs >= 0) {
    parts.push(`t=${(Math.floor(state.offsetMs / 10) / 100).toFixed(2)}`);
  }

  if (state.selection) {
    const value = `${SELECTION_PREFIX[state.selection.kind]}:${state.selection.id}`;
    parts.push(`sel=${encodeURIComponent(value)}`);
  }

  if (state.tab) {
    parts.push(`tab=${state.tab}`);
  }

  return parts.length > 0 ? `#${parts.join("&")}` : "";
}

function parseSelection(raw: string | null): Selection | null {
  if (!raw) {
    return null;
  }

  const separator = raw.indexOf(":");
  const kind = SELECTION_KIND_BY_PREFIX.get(raw.slice(0, separator));
  const id = raw.slice(separator + 1);

  if (separator <= 0 || !kind || id.length === 0 || id.length > MAX_SELECTION_ID_LENGTH) {
    return null;
  }

  return { kind, id };
}
