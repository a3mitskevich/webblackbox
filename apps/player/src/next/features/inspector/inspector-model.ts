import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { extractRequestId } from "@webblackbox/protocol";
import {
  buildPlaywrightActionLines,
  describeEventPhrase,
  findClickReaction,
  inspectEventTarget,
  summarizeActionConsequences,
  type ActionConsequences,
  type ActionTimelineEntry,
  type ClickReaction,
  type EventPhrase,
  type InspectedTarget
} from "@webblackbox/player-sdk";

import type { TimeRange } from "../../../core/time-range.js";
import type { Selection } from "../../../core/navigation.js";
import { resolveSelectedEventId } from "../../controller.js";
import type { LoadedArchive } from "../../state.js";

/** Notable consequences listed under "What it caused". */
export const MAX_CONSEQUENCES = 8;
/** The raw event is shown up to this many characters (a body or snapshot can be megabytes). */
export const RAW_EVENT_MAX_CHARS = 64 * 1024;

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

/** The route chapter the time falls in (`#/lobby`), and when it started. */
function chapterAt(
  archive: LoadedArchive,
  mono: number
): { label: string; startMono: number } | null {
  let found: { label: string; startMono: number } | null = null;

  for (const chapter of archive.view.chapters) {
    if (chapter.startMono > mono) {
      break;
    }

    found = { label: chapter.label, startMono: chapter.startMono };
  }

  return found;
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
  const consequences = triggered
    ? summarizeActionConsequences({
        startMono: triggered.startMono,
        endMono: triggered.endMono,
        events: index.eventsByAct.get(triggered.actId) ?? [],
        requests: triggered.requests.map((request) => {
          const entry = model.waterfallByReqId.get(request.reqId);
          return {
            ...request,
            startMono: entry?.startMono ?? triggered.startMono,
            eventIds: entry?.eventIds ?? []
          };
        }),
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
    reaction: event.type === "user.click" ? findClickReaction(model.events, event) : null,
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

/** The inspection of the selection's event (memoized per archive); `null` when there is none. */
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
    return cached;
  }

  const inspection = buildInspection(archive, event);
  byEvent.set(event.id, inspection);
  return inspection;
}
