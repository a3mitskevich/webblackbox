import {
  displayAttributes,
  elementLabel,
  elementPath,
  renderDomSubtree,
  RrwebDomReplay,
  textContentOf,
  UnsupportedSelectorError,
  querySelectorAll,
  type DomRenderFormat,
  type RrwebDomDiffResult,
  type RrwebDomState,
  type RrwebStateEntry,
  type WebBlackboxPlayer
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import * as z from "zod";

import { defineArchiveTool } from "./registry.js";

/**
 * DOM analysis tools on the rrweb log of an archive (task 60): the page at any moment
 * (`dom_at`), the element of an action with its surroundings (`element_context`), and what an
 * action changed (`dom_diff`). Every element carries its rrweb node id (`wb-id` / `nodeId`) for
 * drill-down; every result is size-capped and says what it cut.
 */

const DEFAULT_MAX_BYTES = 16_000;
const MIN_MAX_BYTES = 1_000;
const MAX_MAX_BYTES = 200_000;
const DEFAULT_DEPTH = 8;
const MAX_DEPTH = 64;
const DEFAULT_MATCHES = 5;
const MAX_MATCHES = 50;
const CONTEXT_ANCESTORS = 12;
const CONTEXT_SIBLINGS = 5;
const CONTEXT_TEXT_CHARS = 400;
const SUMMARY_TEXT_CHARS = 80;
const CONTEXT_HTML_DEPTH = 4;
const DEFAULT_DIFF_ITEMS = 20;
const MAX_DIFF_ITEMS = 200;
/** After an action's trigger, `dom_diff` looks this far ahead unless the action span ends later. */
const DEFAULT_ACTION_WINDOW_MS = 2_000;
const MAX_WINDOW_MS = 600_000;

const maxBytesField = z
  .number()
  .int()
  .min(MIN_MAX_BYTES)
  .max(MAX_MAX_BYTES)
  .optional()
  .describe(`Budget for the returned DOM text in UTF-8 bytes (default ${DEFAULT_MAX_BYTES}).`);

export const domAtInput = {
  mono: z.number().finite().optional().describe("The moment (mono ms). Default: the session end."),
  eventId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Use this event's time (e.g. an error or a click) instead of mono."),
  selector: z
    .string()
    .min(1)
    .max(1_000)
    .optional()
    .describe("CSS selector (type, #id, .class, [attr], descendant/child combinators)."),
  nodeId: z.number().int().optional().describe("Render this element (a wb-id from a result)."),
  depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_DEPTH)
    .optional()
    .describe(`Levels expanded below each root (default ${DEFAULT_DEPTH}).`),
  format: z
    .enum(["html", "outline"])
    .optional()
    .describe("html (default): compact HTML with wb-id; outline: one line per element."),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(MAX_MATCHES)
    .optional()
    .describe(`Selector matches rendered (default ${DEFAULT_MATCHES}).`),
  maxBytes: maxBytesField
};

export type DomAtArgs = {
  mono?: number;
  eventId?: string;
  selector?: string;
  nodeId?: number;
  depth?: number;
  format?: DomRenderFormat;
  maxMatches?: number;
  maxBytes?: number;
};

export const elementContextInput = {
  actionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("An action (actId from summarize_actions): its click or input target."),
  eventId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("A user.click / user.input event: its target. With nodeId: the moment to use."),
  nodeId: z.number().int().optional().describe("An element (wb-id) instead of an action's target."),
  mono: z.number().finite().optional().describe("Moment for nodeId (default: the session end)."),
  maxBytes: maxBytesField
};

export type ElementContextArgs = {
  actionId?: string;
  eventId?: string;
  nodeId?: number;
  mono?: number;
  maxBytes?: number;
};

export const domDiffInput = {
  fromMono: z.number().finite().optional().describe("Start of the comparison (mono ms)."),
  toMono: z.number().finite().optional().describe("End of the comparison (mono ms)."),
  actionId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Compare just before this action's trigger with the end of the action."),
  eventId: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Compare just before this event with windowMs after it."),
  windowMs: z
    .number()
    .int()
    .min(1)
    .max(MAX_WINDOW_MS)
    .optional()
    .describe(`Time after an action's or event's trigger (default ${DEFAULT_ACTION_WINDOW_MS}).`),
  maxItems: z
    .number()
    .int()
    .min(1)
    .max(MAX_DIFF_ITEMS)
    .optional()
    .describe(`Rows per change list (default ${DEFAULT_DIFF_ITEMS}; counts stay exact).`),
  maxBytes: maxBytesField
};

export type DomDiffArgs = {
  fromMono?: number;
  toMono?: number;
  actionId?: string;
  eventId?: string;
  windowMs?: number;
  maxItems?: number;
  maxBytes?: number;
};

type Recording = {
  snapshotMono: number;
  appliedMono: number;
  url: string | null;
  viewport: { width: number; height: number } | null;
  gap: { status: string; reason: string | null; sinceMono: number } | null;
  eventsApplied: number;
  skippedChanges: number;
};

/** Why there is no DOM at a moment, for the agent to act on. */
type Unavailable = { available: false; reason: string; firstSnapshotMono: number | null };

const clamp = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value ?? fallback)));

function describeGap(gap: RrwebStateEntry | undefined): Recording["gap"] {
  return gap
    ? { status: gap.state.status, reason: gap.state.reason ?? null, sinceMono: gap.mono }
    : null;
}

function describeRecording(state: RrwebDomState): Recording {
  return {
    snapshotMono: state.snapshotMono,
    appliedMono: state.appliedMono,
    url: state.href ?? null,
    viewport: state.viewport ?? null,
    gap: describeGap(state.gap),
    eventsApplied: state.eventsApplied,
    skippedChanges: state.skippedChanges
  };
}

function unavailable(replay: RrwebDomReplay, mono: number): Unavailable {
  const first = replay.timeline.fullSnapshots[0];
  const firstMono = first === undefined ? null : (replay.timeline.entries[first]?.mono ?? null);

  return {
    available: false,
    reason:
      firstMono === null
        ? "This archive has no rrweb DOM log (recorded before rrweb, with DOM off, or on a page " +
          "over the recorder's node limit: query_events for dom.snapshot / dom.rrweb.event)."
        : `No DOM before the first full snapshot at mono ${firstMono} (asked for ${mono}).`,
    firstSnapshotMono: firstMono
  };
}

function findEvent(events: readonly WebBlackboxEvent[], eventId: string): WebBlackboxEvent {
  const event = events.find((entry) => entry.id === eventId);

  if (!event) {
    throw new Error(`Event '${eventId}' not found in the archive.`);
  }

  return event;
}

function sessionEnd(events: readonly WebBlackboxEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.mono), Number.NEGATIVE_INFINITY);
}

function resolveMono(
  events: readonly WebBlackboxEvent[],
  mono: number | undefined,
  eventId: string | undefined
): { mono: number; eventId: string | null } {
  if (eventId !== undefined) {
    return { mono: findEvent(events, eventId).mono, eventId };
  }

  return { mono: mono ?? sessionEnd(events), eventId: null };
}

/** `dom_at` on an open archive. */
export function domAtFromPlayer(player: WebBlackboxPlayer, args: DomAtArgs) {
  const events = player.events;
  const at = resolveMono(events, args.mono, args.eventId);
  const replay = RrwebDomReplay.fromEvents(events);
  const state = replay.domAt(at.mono);
  const documentId = state?.tree.rootId ?? null;

  if (!state || documentId === null) {
    return { at, ...unavailable(replay, at.mono) };
  }

  const tree = state.tree;
  const format = args.format ?? "html";
  const depth = clamp(args.depth, DEFAULT_DEPTH, 0, MAX_DEPTH);
  const maxBytes = clamp(args.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);
  const rootId = args.nodeId ?? documentId;

  if (!tree.has(rootId)) {
    throw new Error(
      `Node ${rootId} is not in the DOM at mono ${at.mono} (removed, not yet added, or from another recorder start).`
    );
  }

  let roots = [rootId];
  let matches: { selector: string; total: number; nodeIds: number[] } | null = null;

  if (args.selector !== undefined) {
    const limit = MAX_MATCHES * 4;
    let found: number[];

    try {
      found = querySelectorAll(tree, rootId, args.selector, limit);
    } catch (error) {
      if (error instanceof UnsupportedSelectorError) {
        throw new Error(`Unsupported selector: ${error.message}`);
      }

      throw error;
    }

    const shown = found.slice(0, clamp(args.maxMatches, DEFAULT_MATCHES, 1, MAX_MATCHES));
    matches = { selector: args.selector, total: found.length, nodeIds: found.slice(0, limit) };
    roots = shown;
  }

  const share = Math.max(MIN_MAX_BYTES / 4, Math.floor(maxBytes / Math.max(1, roots.length)));
  const rendered = roots.map((id) => ({
    nodeId: id,
    path: elementPath(tree, id),
    ...renderDomSubtree(tree, id, { format, depth, maxBytes: share })
  }));

  return {
    at,
    available: true as const,
    recording: describeRecording(state),
    format,
    ...(matches ? { matches } : {}),
    roots: rendered.map((entry) => ({
      nodeId: entry.nodeId,
      path: entry.path,
      content: entry.content,
      bytes: entry.bytes,
      truncated: entry.truncated,
      omittedNodeIds: entry.omittedNodeIds
    })),
    hint:
      "Elements carry wb-id: call dom_at with nodeId (and the same mono) to expand a cut part, " +
      "element_context for one element, dom_diff for what changed."
  };
}

function elementSummary(state: RrwebDomState, id: number) {
  const node = state.tree.get(id)!;
  return {
    nodeId: id,
    label: elementLabel(node),
    text: textContentOf(state.tree, id, SUMMARY_TEXT_CHARS)
  };
}

function siblingSummaries(state: RrwebDomState, id: number) {
  const node = state.tree.get(id)!;
  const parent = node.parentId === null ? undefined : state.tree.get(node.parentId);
  const elements = (parent?.children ?? []).filter(
    (child) => state.tree.get(child)?.kind === "element"
  );
  const index = elements.indexOf(id);

  return {
    total: Math.max(0, elements.length - 1),
    before: elements
      .slice(Math.max(0, index - CONTEXT_SIBLINGS), Math.max(0, index))
      .map((sibling) => elementSummary(state, sibling)),
    after: elements
      .slice(index + 1, index + 1 + CONTEXT_SIBLINGS)
      .map((sibling) => elementSummary(state, sibling))
  };
}

/** The closest ancestor text that says more than the element itself (a row, a card, a form). */
function nearbyText(state: RrwebDomState, id: number): { nodeId: number; text: string } | null {
  const own = textContentOf(state.tree, id, CONTEXT_TEXT_CHARS);

  for (const ancestor of state.tree.ancestors(id)) {
    if (ancestor.kind !== "element" || ancestor.tagName === "body" || ancestor.tagName === "html") {
      break;
    }

    const text = textContentOf(state.tree, ancestor.id, CONTEXT_TEXT_CHARS);

    if (text.length > own.length) {
      return { nodeId: ancestor.id, text };
    }
  }

  return null;
}

type Target = {
  nodeId: number;
  mono: number;
  how: string;
  actionId: string | null;
  eventId: string | null;
  click?: { kind: string; x: number | null; y: number | null };
};

function actionTrigger(player: WebBlackboxPlayer, actionId: string): WebBlackboxEvent {
  const span = player.buildDerived().actionSpans.find((entry) => entry.actId === actionId);

  if (!span) {
    throw new Error(`Action '${actionId}' not found (summarize_actions lists actIds).`);
  }

  return findEvent(player.events, span.triggerEventId);
}

function pointOf(event: WebBlackboxEvent): { x: number; y: number } | undefined {
  const data = event.data as { x?: unknown; y?: unknown } | null;
  return typeof data?.x === "number" && typeof data.y === "number"
    ? { x: data.x, y: data.y }
    : undefined;
}

/** The rrweb node an action's (or an event's) user interaction targeted. */
function targetOfEvent(
  replay: RrwebDomReplay,
  trigger: WebBlackboxEvent,
  actionId: string | null
): Target {
  const base = { actionId, eventId: trigger.id };

  if (
    trigger.type === "user.click" ||
    trigger.type === "user.dblclick" ||
    trigger.type === "user.contextmenu"
  ) {
    const click = replay.findClick(trigger.mono, pointOf(trigger));

    if (click) {
      return {
        ...base,
        nodeId: click.nodeId,
        mono: click.mono,
        how: "rrweb click recorded with the event",
        click: { kind: click.kind, x: click.x ?? null, y: click.y ?? null }
      };
    }
  } else if (trigger.type === "user.input" || trigger.type === "user.keydown") {
    const input = replay.findInput(trigger.mono);

    if (input) {
      return {
        ...base,
        nodeId: input.nodeId,
        mono: input.mono,
        how: "rrweb field input recorded with the event"
      };
    }
  }

  const gap = replay.domAt(trigger.mono)?.gap;
  throw new Error(
    `No rrweb target for ${trigger.type} '${trigger.id}'` +
      (gap
        ? ` (the DOM recorder was ${gap.state.status}${gap.state.reason ? `: ${gap.state.reason}` : ""} since mono ${gap.mono}).`
        : ". Use dom_at at its mono, or the event's own target fields.")
  );
}

/** `element_context` on an open archive. */
export function elementContextFromPlayer(player: WebBlackboxPlayer, args: ElementContextArgs) {
  const events = player.events;
  const replay = RrwebDomReplay.fromEvents(events);
  let target: Target;

  if (args.nodeId !== undefined) {
    const at = resolveMono(events, args.mono, args.eventId);
    target = {
      nodeId: args.nodeId,
      mono: at.mono,
      how: "nodeId",
      actionId: null,
      eventId: at.eventId
    };
  } else if (args.actionId !== undefined) {
    target = targetOfEvent(replay, actionTrigger(player, args.actionId), args.actionId);
  } else if (args.eventId !== undefined) {
    target = targetOfEvent(replay, findEvent(events, args.eventId), null);
  } else {
    throw new Error("Give actionId, eventId, or nodeId.");
  }

  const state = replay.domAt(target.mono);

  if (!state) {
    return { target, ...unavailable(replay, target.mono) };
  }

  const node = state.tree.get(target.nodeId);

  if (!node || node.kind !== "element") {
    throw new Error(`Node ${target.nodeId} is not an element of the DOM at mono ${target.mono}.`);
  }

  const maxBytes = clamp(args.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);
  const outer = renderDomSubtree(state.tree, node.id, {
    depth: CONTEXT_HTML_DEPTH,
    maxBytes: Math.floor(maxBytes / 2)
  });

  return {
    available: true as const,
    target: {
      ...target,
      tag: node.tagName,
      label: elementLabel(node),
      path: elementPath(state.tree, node.id),
      attributes: Object.fromEntries(displayAttributes(node)),
      text: textContentOf(state.tree, node.id, CONTEXT_TEXT_CHARS)
    },
    recording: describeRecording(state),
    outerHtml: {
      content: outer.content,
      bytes: outer.bytes,
      truncated: outer.truncated,
      omittedNodeIds: outer.omittedNodeIds
    },
    ancestors: state.tree
      .ancestors(node.id)
      .filter((ancestor) => ancestor.kind === "element")
      .slice(0, CONTEXT_ANCESTORS)
      .map((ancestor) => ({ nodeId: ancestor.id, label: elementLabel(ancestor) })),
    siblings: siblingSummaries(state, node.id),
    nearbyText: nearbyText(state, node.id)
  };
}

/** Halves the rows until the JSON fits; counts stay exact. */
function fitDiff(diff: RrwebDomDiffResult, maxBytes: number): RrwebDomDiffResult {
  let current = diff;
  let rows = Math.max(
    diff.added.length,
    diff.removed.length,
    diff.attributes.length,
    diff.texts.length,
    diff.values.length
  );

  while (rows > 1 && JSON.stringify(current).length > maxBytes) {
    rows = Math.floor(rows / 2);
    current = {
      ...diff,
      added: diff.added.slice(0, rows),
      removed: diff.removed.slice(0, rows),
      attributes: diff.attributes.slice(0, rows),
      texts: diff.texts.slice(0, rows),
      values: diff.values.slice(0, rows),
      truncated: true
    };
  }

  return current;
}

/** `dom_diff` on an open archive. */
export function domDiffFromPlayer(player: WebBlackboxPlayer, args: DomDiffArgs) {
  const events = player.events;
  const replay = RrwebDomReplay.fromEvents(events);
  const windowMs = clamp(args.windowMs, DEFAULT_ACTION_WINDOW_MS, 1, MAX_WINDOW_MS);
  let from: number;
  let to: number;
  let around: { actionId: string | null; eventId: string } | null = null;

  if (args.actionId !== undefined || args.eventId !== undefined) {
    const trigger =
      args.actionId !== undefined
        ? actionTrigger(player, args.actionId)
        : findEvent(events, args.eventId!);
    const span =
      args.actionId === undefined
        ? undefined
        : player.buildDerived().actionSpans.find((entry) => entry.actId === args.actionId);
    // Just before the trigger: its own effects belong to "after".
    from = trigger.mono - 1;
    to = Math.max(trigger.mono + windowMs, span?.endMono ?? Number.NEGATIVE_INFINITY);
    around = { actionId: args.actionId ?? null, eventId: trigger.id };
  } else if (args.fromMono !== undefined && args.toMono !== undefined) {
    from = Math.min(args.fromMono, args.toMono);
    to = Math.max(args.fromMono, args.toMono);
  } else {
    throw new Error("Give actionId, eventId, or both fromMono and toMono.");
  }

  // A start before the first full snapshot (the session's first moments) starts at that snapshot.
  const firstIndex = replay.timeline.fullSnapshots[0];
  const firstSnapshot =
    firstIndex === undefined ? undefined : replay.timeline.entries[firstIndex]?.mono;
  const fromClamped = firstSnapshot !== undefined && from < firstSnapshot && firstSnapshot <= to;

  if (fromClamped) {
    from = firstSnapshot;
  }

  const maxItems = clamp(args.maxItems, DEFAULT_DIFF_ITEMS, 1, MAX_DIFF_ITEMS);
  const diff = replay.diff(from, to, maxItems);

  if (!diff) {
    return { from, to, around, ...unavailable(replay, from) };
  }

  const gaps = replay.timeline.states
    .filter((entry) => entry.mono > from && entry.mono <= to && entry.state.status !== "resumed")
    .map((entry) => describeGap(entry));
  const maxBytes = clamp(args.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);

  return {
    available: true as const,
    from,
    to,
    around,
    ...(fromClamped ? { fromNote: "Started at the first full snapshot of the DOM log." } : {}),
    ...(gaps.length > 0
      ? {
          gaps,
          gapNote:
            "The DOM recorder paused in this window: changes inside a gap are missing; the next " +
            "full snapshot shows their result."
        }
      : {}),
    ...fitDiff(diff, maxBytes),
    hint: "nodeIds of 'added' and the changes are from `to`, of 'removed' from `from` (dom_at with that mono)."
  };
}

export const domAtTool = defineArchiveTool({
  name: "dom_at",
  description:
    "The page's DOM at a moment (mono or an event's time), rebuilt from the archive's rrweb log: " +
    "compact HTML or an outline of the page, a subtree (nodeId) or selector matches, within a " +
    "byte budget. Elements carry wb-id for drill-down; recorder gaps are reported.",
  inputSchema: domAtInput,
  run: async (args, archive) => ({
    data: { archive: archive.path, ...domAtFromPlayer(await archive.open(), args) }
  })
});

export const elementContextTool = defineArchiveTool({
  name: "element_context",
  description:
    "The element an action or a user.click / user.input event targeted (or a wb-id at a moment): " +
    "its outerHTML, attributes, path of ancestors, siblings and nearby text, from the rrweb log.",
  inputSchema: elementContextInput,
  run: async (args, archive) => ({
    data: { archive: archive.path, ...elementContextFromPlayer(await archive.open(), args) }
  })
});

export const domDiffTool = defineArchiveTool({
  name: "dom_diff",
  description:
    "What changed in the DOM between two moments, or around an action / event (just before it to " +
    "the end of the action or windowMs later): elements added and removed, attribute, text and " +
    "field value changes, with wb-ids and exact counts.",
  inputSchema: domDiffInput,
  run: async (args, archive) => ({
    data: { archive: archive.path, ...domDiffFromPlayer(await archive.open(), args) }
  })
});
