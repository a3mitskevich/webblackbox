import {
  findOnPage,
  findPageStateAt,
  listA11ySnapshots,
  type A11ySnapshotEntry,
  type PagePresenceSpan,
  type ResolvedPageStateAnchor
} from "@webblackbox/player-sdk";
import * as z from "zod";

import { defineArchiveTool, type ArchiveHandle } from "./registry.js";

const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 48_000;
const MIN_MAX_CHARS = 500;
const DEFAULT_SPAN_LIMIT = 20;
const MAX_SPAN_LIMIT = 200;
const MAX_QUERY_CHARS = 200;
/** Says what the snapshots cover, so an absent node is not read as gone from the page. */
const SCOPE_NOTE =
  "Snapshots cover the viewport of the top document (same-origin frames inlined): a node missing " +
  "from a snapshot may be scrolled out of view rather than gone from the page.";
/** Says why a disappearance can be uncertain. */
const PRESENCE_NOTE =
  `${SCOPE_NOTE} A snapshot marked truncated was cut at the capture budget, so a match missing ` +
  "from it may lie past the cut; in masked snapshots blocked content and masked values cannot match.";

export const pageStateAtInput = {
  eventId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("The page state after this event (a click, an error, a request, a navigation…)."),
  actionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "The page state after this action: its ref.act, or a derived:<eventId> id from the action " +
        "timeline."
    ),
  mono: z.number().finite().optional().describe("The page state at this monotonic time (ms)."),
  t: z.number().finite().optional().describe("The page state at this wall-clock time (epoch ms)."),
  maxChars: z
    .number()
    .int()
    .min(MIN_MAX_CHARS)
    .max(MAX_MAX_CHARS)
    .optional()
    .describe(
      `Budget in characters for the tree text of all returned snapshots together (default ` +
        `${DEFAULT_MAX_CHARS}); the other fields and JSON escaping come on top.`
    )
};

export type PageStateAtArgs = {
  eventId?: string;
  actionId?: string;
  mono?: number;
  t?: number;
  maxChars?: number;
};

export const findOnPageInput = {
  text: z
    .string()
    .min(1)
    .max(MAX_QUERY_CHARS)
    .optional()
    .describe("Text to look for in accessible names and values (case-insensitive)."),
  role: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("ARIA role to look for (alert, dialog, button, textbox, progressbar…)."),
  monoStart: z.number().finite().optional(),
  monoEnd: z.number().finite().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SPAN_LIMIT)
    .optional()
    .describe(`Most presence spans returned (default ${DEFAULT_SPAN_LIMIT}).`)
};

export type FindOnPageArgs = {
  text?: string;
  role?: string;
  monoStart?: number;
  monoEnd?: number;
  limit?: number;
};

/** One snapshot as the tools return it; `tree` is cut to the tool's budget. */
export type PageStateSnapshot = {
  eventId: string;
  t: number;
  mono: number;
  actionId?: string;
  trigger: A11ySnapshotEntry["trigger"];
  url: string;
  title?: string;
  viewport: A11ySnapshotEntry["viewport"];
  masking: A11ySnapshotEntry["masking"];
  /** Nodes the capture left out (its own budget). */
  omittedNodes: number;
  tree: string;
  /** Lines this tool left out to stay within `maxChars`. */
  treeLinesCut?: number;
};

export type PageStateAtResult = {
  path: string;
  anchor: ResolvedPageStateAnchor;
  snapshotsInArchive: number;
  /** The snapshot taken for the anchor event or action. */
  linked?: PageStateSnapshot;
  /** The state at the anchor: the latest snapshot at or before it. */
  before?: PageStateSnapshot;
  /** The first snapshot after the anchor (when it is not the linked one). */
  after?: PageStateSnapshot;
  note: string;
};

/**
 * What the user saw and could do around a moment: the accessibility snapshot linked to an event or
 * action, and the nearest snapshots before and after it, with their trees within `maxChars`.
 */
export async function getPageStateAt(
  args: PageStateAtArgs,
  archive: ArchiveHandle
): Promise<PageStateAtResult> {
  const anchors = [args.eventId, args.actionId, args.mono, args.t].filter(
    (value) => value !== undefined
  );

  if (anchors.length !== 1) {
    throw new Error("Pass exactly one of eventId, actionId, mono or t.");
  }

  const player = await archive.open();
  const snapshots = listA11ySnapshots(player.events);
  const state = findPageStateAt(player.events, args, snapshots);

  if (!state) {
    throw new Error(
      args.eventId !== undefined
        ? `Event '${args.eventId}' not found in the archive.`
        : args.actionId !== undefined
          ? `Action '${args.actionId}' not found in the archive.`
          : "The archive has no events to place that time against."
    );
  }

  const after =
    state.after && state.after.eventId !== state.linked?.eventId ? state.after : undefined;
  const before =
    state.before && state.before.eventId !== state.linked?.eventId ? state.before : undefined;
  const picked = [state.linked, before, after];
  const budgets = splitBudget(
    picked.map((entry) => entry?.tree.length ?? 0),
    args.maxChars ?? DEFAULT_MAX_CHARS
  );
  const [linked, beforeOut, afterOut] = picked.map((entry, index) =>
    entry ? toSnapshot(entry, budgets[index] ?? 0) : undefined
  );

  return {
    path: archive.path,
    anchor: state.anchor,
    snapshotsInArchive: snapshots.length,
    ...(linked ? { linked } : {}),
    ...(beforeOut ? { before: beforeOut } : {}),
    ...(afterOut ? { after: afterOut } : {}),
    note:
      snapshots.length === 0
        ? `The archive has no accessibility snapshots. ${SCOPE_NOTE}`
        : SCOPE_NOTE
  };
}

export type FindOnPageResult = {
  path: string;
  snapshotsScanned: number;
  presentAtEnd: boolean;
  spans: PagePresenceSpan[];
  /** Spans beyond `limit`. */
  spansOmitted: number;
  note: string;
};

/** When a text or a role was on screen: spans of consecutive snapshots in which it matched. */
export async function findOnPageInArchive(
  args: FindOnPageArgs,
  archive: ArchiveHandle
): Promise<FindOnPageResult> {
  if (!args.text && !args.role) {
    throw new Error("Pass a text, a role, or both.");
  }

  const player = await archive.open();
  const result = findOnPage(listA11ySnapshots(player.events), args);
  const limit = args.limit ?? DEFAULT_SPAN_LIMIT;

  return {
    path: archive.path,
    snapshotsScanned: result.snapshotsScanned,
    presentAtEnd: result.presentAtEnd,
    spans: result.spans.slice(0, limit),
    spansOmitted: Math.max(0, result.spans.length - limit),
    note: PRESENCE_NOTE
  };
}

export const pageStateAtTool = defineArchiveTool({
  name: "page_state_at",
  description:
    "What the user saw and could do at a moment: the accessibility snapshot (roles, names, " +
    "states, visible text of the viewport) taken for an event or action, and the nearest " +
    "snapshots before and after it. Pass exactly one of eventId, actionId, mono or t.",
  inputSchema: pageStateAtInput,
  run: async (args, archive) => ({ data: { ...(await getPageStateAt(args, archive)) } })
});

export const findOnPageTool = defineArchiveTool({
  name: "find_on_page",
  description:
    "When something was on screen: the spans of accessibility snapshots in which a text (in " +
    "names and values) and/or a role (alert, dialog, button…) appeared, and when it disappeared.",
  inputSchema: findOnPageInput,
  run: async (args, archive) => ({ data: { ...(await findOnPageInArchive(args, archive)) } })
});

/** Shares `total` between trees: each gets an equal part, and what a short one leaves goes on. */
export function splitBudget(lengths: readonly number[], total: number): number[] {
  const budgets = lengths.map(() => 0);
  let remaining = total;
  let open = lengths
    .map((length, index) => ({ length, index }))
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.length - right.length);

  while (open.length > 0) {
    const share = Math.floor(remaining / open.length);
    const [shortest] = open;

    if (shortest && shortest.length <= share) {
      budgets[shortest.index] = shortest.length;
      remaining -= shortest.length;
      open = open.slice(1);
      continue;
    }

    for (const entry of open) {
      budgets[entry.index] = share;
    }

    break;
  }

  return budgets;
}

function toSnapshot(entry: A11ySnapshotEntry, maxChars: number): PageStateSnapshot {
  const cut = cutTree(entry.tree, maxChars);

  return {
    eventId: entry.eventId,
    t: entry.t,
    mono: entry.mono,
    ...(entry.actionId ? { actionId: entry.actionId } : {}),
    trigger: entry.trigger,
    url: entry.url,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    viewport: entry.viewport,
    masking: entry.masking,
    omittedNodes: entry.omittedNodes,
    tree: cut.tree,
    ...(cut.linesCut > 0 ? { treeLinesCut: cut.linesCut } : {})
  };
}

/** Whole lines within `maxChars`; the rest is counted, never cut mid-line. */
function cutTree(tree: string, maxChars: number): { tree: string; linesCut: number } {
  if (tree.length <= maxChars) {
    return { tree, linesCut: 0 };
  }

  const lines = tree.split("\n");
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    if (used + line.length + 1 > maxChars) {
      break;
    }

    kept.push(line);
    used += line.length + 1;
  }

  return { tree: kept.join("\n"), linesCut: lines.length - kept.length };
}
