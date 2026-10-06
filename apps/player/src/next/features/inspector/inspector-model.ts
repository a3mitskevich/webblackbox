import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { extractRequestId } from "@webblackbox/protocol";
import {
  buildPlaywrightActionLines,
  buildRouteChapters,
  createClickReactionLookup,
  describeEventPhrase,
  inspectEventTarget,
  summarizeActionConsequences,
  type ActionConsequences,
  type ActionTimelineEntry,
  type ClickReaction,
  type ClickReactionLookup,
  type EventPhrase,
  type InspectedTarget,
  type RouteChapter
} from "@webblackbox/player-sdk";

import type { TimeRange } from "../../../core/time-range.js";
import type { Selection } from "../../../core/navigation.js";
import { collectActionRequests } from "../../../core/action-requests.js";
import type { ArchiveModel } from "../../../core/archive-model.js";
import { lowerBoundByMono } from "../../../lib/range.js";
import { resolveSelectedEventId } from "../../controller.js";
import type { LoadedArchive } from "../../state.js";

/** Notable consequences listed under "What it caused". */
export const MAX_CONSEQUENCES = 8;
/** The raw event is shown up to this many characters (a body or snapshot can be megabytes). */
export const RAW_EVENT_MAX_CHARS = 64 * 1024;
/** Inspections kept per archive (least recently used ones go first). */
export const INSPECTION_CACHE_SIZE = 50;
/** How far back a frame event looks for the top page's viewport. */
const TOP_VIEWPORT_LOOKBACK_EVENTS = 5_000;

type ViewportSize = { width: number; height: number };

/** Everything the event inspector shows about the selected event. */
export type Inspection = {
  event: WebBlackboxEvent;
  /** Time since the recording started. */
  offsetMs: number;
  /** The action the event triggers, or the one it is a consequence of. */
  action: ActionTimelineEntry | null;
  /** `A-4`: the action's id without its zero padding (`A-000004`). */
  actionLabel: string | null;
  /** The event starts `action` (a click, a navigation…). */
  isTrigger: boolean;
  target: InspectedTarget | null;
  /** The event comes from an iframe (`event.frame`, or a recorded frame offset). */
  inFrame: boolean;
  /**
   * The top page's viewport at the event (the video's coordinate space): the event's own one in
   * the top frame, the latest top-frame event's for an iframe target.
   */
  topViewport: ViewportSize | null;
  reaction: ClickReaction | null;
  /** What the action caused; only for the event that triggers it. */
  consequences: ActionConsequences | null;
  phrase: EventPhrase;
  /** The Playwright lines replaying this event (empty when it has none). */
  playwrightStep: string[];
  /** The request the event belongs to (a request event or a resource error). */
  reqId: string | null;
  /** Range for "Playwright from …": the page the action happened on, up to the action's end. */
  playwrightRange: TimeRange;
  raw: { text: string; truncated: boolean };
};

type ArchiveIndex = {
  eventsByAct: Map<string, WebBlackboxEvent[]>;
  actionByTrigger: Map<string, ActionTimelineEntry>;
  actionById: Map<string, ActionTimelineEntry>;
};

const indexCache = new WeakMap<LoadedArchive, ArchiveIndex>();
const inspectionCache = new WeakMap<LoadedArchive, Map<string, Inspection>>();
const routeChapterCache = new WeakMap<LoadedArchive, RouteChapter[]>();
const reactionLookupCache = new WeakMap<LoadedArchive, ClickReactionLookup>();

function indexOf(archive: LoadedArchive): ArchiveIndex {
  const cached = indexCache.get(archive);

  if (cached) {
    return cached;
  }

  const eventsByAct = new Map<string, WebBlackboxEvent[]>();

  for (const event of archive.model.events) {
    const actId = event.ref?.act;

    if (actId) {
      const list = eventsByAct.get(actId);

      if (list) {
        list.push(event);
      } else {
        eventsByAct.set(actId, [event]);
      }
    }
  }

  const actionByTrigger = new Map<string, ActionTimelineEntry>();
  const actionById = new Map<string, ActionTimelineEntry>();

  for (const action of archive.model.actionTimeline) {
    actionByTrigger.set(action.triggerEventId, action);
    actionById.set(action.actId, action);
  }

  const index = { eventsByAct, actionByTrigger, actionById };
  indexCache.set(archive, index);
  return index;
}

/** `A-000004` → `A-4`; other id shapes stay as they are. */
export function compactActionId(actId: string): string {
  return actId.replace(/^([A-Za-z]+-)0+(?=\d)/, "$1");
}

/**
 * Route chapters before the chapter strip compacts them (`compactChapters` merges narrow ones
 * into `a → b → c` and marks reloads with ↻): the summary names the one route the action was on.
 */
function routeChaptersOf(archive: LoadedArchive): RouteChapter[] {
  const cached = routeChapterCache.get(archive);

  if (cached) {
    return cached;
  }

  const chapters = buildRouteChapters(archive.model.events, {
    endMono: archive.model.maxMono,
    initialUrl: archive.player.archive.manifest.site.origin
  });
  routeChapterCache.set(archive, chapters);
  return chapters;
}

/** The route chapter the time falls in (`#/lobby`), and when it started. */
function chapterAt(
  archive: LoadedArchive,
  mono: number
): { label: string; startMono: number } | null {
  let found: { label: string; startMono: number } | null = null;

  for (const chapter of routeChaptersOf(archive)) {
    if (chapter.startMono > mono) {
      break;
    }

    found = { label: chapter.label, startMono: chapter.startMono };
  }

  return found;
}

/**
 * Click → reaction probe, built once per archive. Probes store the click's capture mono, and the
 * model may hold events re-timed to wall clock (`normalizePlaybackEvents`): like the dead-click
 * lane, the lookup reads the capture mono from the player's own (unchanged) events.
 */
function reactionLookupOf(archive: LoadedArchive): ClickReactionLookup {
  const cached = reactionLookupCache.get(archive);

  if (cached) {
    return cached;
  }

  const { model } = archive;
  const captureMonoById = new Map<string, number>();

  for (const raw of archive.player.events) {
    if (model.eventById.get(raw.id)?.mono !== raw.mono) {
      captureMonoById.set(raw.id, raw.mono);
    }
  }

  const lookup = createClickReactionLookup(model.events, {
    captureMonoOf: (event) => captureMonoById.get(event.id) ?? event.mono
  });
  reactionLookupCache.set(archive, lookup);
  return lookup;
}

function isFrameEvent(event: WebBlackboxEvent): boolean {
  const data = asRecord(event.data);
  return Boolean(event.frame) || asRecord(data?.frameOffset) !== null;
}

function readViewport(event: WebBlackboxEvent): ViewportSize | null {
  const viewport = asRecord(asRecord(event.data)?.viewport);
  const width = viewport?.w;
  const height = viewport?.h;

  return typeof width === "number" && width > 0 && typeof height === "number" && height > 0
    ? { width, height }
    : null;
}

/** The top page's viewport at `event`: its own, or the latest top-frame event's before it. */
function topViewportAt(model: ArchiveModel, event: WebBlackboxEvent): ViewportSize | null {
  if (!isFrameEvent(event)) {
    return readViewport(event);
  }

  const { events } = model;
  let index = lowerBoundByMono(events, event.mono, (candidate) => candidate.mono);

  while ((events[index]?.mono ?? Number.POSITIVE_INFINITY) <= event.mono) {
    index += 1;
  }

  for (let step = 0; step < TOP_VIEWPORT_LOOKBACK_EVENTS && index > 0; step += 1) {
    index -= 1;
    const candidate = events[index];
    const viewport =
      candidate && candidate.id !== event.id && !isFrameEvent(candidate)
        ? readViewport(candidate)
        : null;

    if (viewport) {
      return viewport;
    }
  }

  return null;
}

function rawText(event: WebBlackboxEvent): { text: string; truncated: boolean } {
  const text = JSON.stringify(event, null, 2);
  return text.length > RAW_EVENT_MAX_CHARS
    ? { text: `${text.slice(0, RAW_EVENT_MAX_CHARS)}\n…`, truncated: true }
    : { text, truncated: false };
}

function buildInspection(archive: LoadedArchive, event: WebBlackboxEvent): Inspection {
  const { model } = archive;
  const index = indexOf(archive);
  const triggered = index.actionByTrigger.get(event.id);
  const action =
    triggered ?? (event.ref?.act ? index.actionById.get(event.ref.act) : undefined) ?? null;
  const chapter = chapterAt(archive, event.mono);
  const actionEvents = triggered ? (index.eventsByAct.get(triggered.actId) ?? []) : [];
  const consequences = triggered
    ? summarizeActionConsequences({
        startMono: triggered.startMono,
        triggerEventId: event.id,
        endMono: triggered.endMono,
        events: actionEvents,
        requests: collectActionRequests(model, actionEvents),
        maxItems: MAX_CONSEQUENCES
      })
    : null;
  const endMono = Math.max(event.mono, action?.endMono ?? event.mono);

  return {
    event,
    offsetMs: event.mono - model.minMono,
    action,
    actionLabel: action ? compactActionId(action.actId) : null,
    isTrigger: Boolean(triggered),
    target: inspectEventTarget(event),
    inFrame: isFrameEvent(event),
    topViewport: topViewportAt(model, event),
    reaction: event.type === "user.click" ? reactionLookupOf(archive)(event) : null,
    consequences,
    phrase: describeEventPhrase(event, { route: chapter?.label ?? null }),
    playwrightStep: buildPlaywrightActionLines([event]).map((line) => line.trim()),
    reqId: extractRequestId(event) ?? null,
    playwrightRange: {
      startMono: Math.min(chapter?.startMono ?? model.minMono, event.mono),
      endMono
    },
    raw: rawText(event)
  };
}

/**
 * The inspection of the selection's event, memoized per archive (the last
 * `INSPECTION_CACHE_SIZE` events); `null` when there is none.
 */
export function inspectSelection(
  archive: LoadedArchive,
  selection: Selection | null
): Inspection | null {
  const eventId = resolveSelectedEventId(archive, selection);
  const event = eventId ? archive.model.eventById.get(eventId) : undefined;

  if (!event) {
    return null;
  }

  let byEvent = inspectionCache.get(archive);

  if (!byEvent) {
    byEvent = new Map();
    inspectionCache.set(archive, byEvent);
  }

  const cached = byEvent.get(event.id);

  if (cached) {
    // Most recently used last: a Map iterates in insertion order.
    byEvent.delete(event.id);
    byEvent.set(event.id, cached);
    return cached;
  }

  const inspection = buildInspection(archive, event);
  byEvent.set(event.id, inspection);

  for (const staleId of byEvent.keys()) {
    if (byEvent.size <= INSPECTION_CACHE_SIZE) {
      break;
    }

    byEvent.delete(staleId);
  }

  return inspection;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
