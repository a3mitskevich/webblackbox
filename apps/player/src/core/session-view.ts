import type { WebBlackboxEvent } from "@webblackbox/protocol";
import {
  buildRouteChapters,
  groupProblems,
  listProblemOccurrences,
  type PlayerArchive,
  type ProblemGroup
} from "@webblackbox/player-sdk";

import type { ArchiveModel } from "./archive-model.js";
import { findIdleGaps, type IdleGap } from "./playback-clock.js";
import {
  buildDensityBins,
  buildLaneTicks,
  compactChapters,
  ratioOf,
  type DensityBin,
  type TimelineChapter,
  type TimelineWindow
} from "./timeline-lanes.js";

export type ActionMarkKind = "click" | "navigation" | "input" | "other";

/** A user action on the Actions lane. */
export type ActionMark = {
  actId: string;
  eventId: string;
  mono: number;
  ratio: number;
  kind: ActionMarkKind;
  triggerType: string | null;
};

/** Header facts about the session. */
export type SessionMeta = {
  origin: string;
  title: string | null;
  mode: string;
  createdAt: string;
  encrypted: boolean;
  durationMs: number;
  eventCount: number;
  /** Other tabs of the recorded site seen during the session (0 when the archive has none). */
  otherTabs: number;
  /** Event the tabs chip jumps to (first tabs snapshot or change). */
  tabsEventId: string | null;
  hasVideo: boolean;
  screenshotCount: number;
};

/** Everything the React player derives once per opened archive for the stage and timeline. */
export type SessionView = {
  window: TimelineWindow;
  maxMono: number;
  meta: SessionMeta;
  chapters: TimelineChapter[];
  densityBins: DensityBin[];
  errorTicks: number[];
  realtimeTicks: number[];
  actionMarks: ActionMark[];
  /** Failures grouped for the problems strip (player-sdk `groupProblems`). */
  problems: ProblemGroup[];
  /**
   * One event per problem occurrence, in time order, for E / Shift+E and the Errors lane: failed
   * requests, exceptions and console errors (by `data.level`, PROPOSAL §2.3) — first-party ones,
   * or all when every problem is third-party.
   */
  errorEvents: WebBlackboxEvent[];
  idleGaps: IdleGap[];
};

function classifyAction(triggerType: string | null): ActionMarkKind {
  if (!triggerType) {
    return "other";
  }

  if (triggerType.startsWith("nav.")) {
    return "navigation";
  }

  if (/click|submit|pointer/.test(triggerType)) {
    return "click";
  }

  return /input|keydown|change/.test(triggerType) ? "input" : "other";
}

export function buildSessionView(
  archive: Pick<PlayerArchive, "manifest">,
  model: ArchiveModel
): SessionView {
  const window: TimelineWindow = { minMono: model.minMono, durationMono: model.durationMono };
  const manifest = archive.manifest;
  const tabsEvent = model.tabsContext.snapshots[0] ?? model.tabsContext.changes[0];
  const problems = groupProblems({
    events: model.events,
    requests: model.waterfall,
    firstPartyUrl: manifest.site.origin
  });
  // E / Shift+E and the Errors lane skip third-party noise (analytics, extensions) unless the
  // recording has nothing else; its strip chips still reach it.
  const ownProblems = problems.filter((group) => !group.thirdParty);
  const steppedProblems = ownProblems.length > 0 ? ownProblems : problems;
  const errorEvents = listProblemOccurrences(steppedProblems).flatMap((occurrence) => {
    const event = model.eventById.get(occurrence.eventId);
    return event ? [event] : [];
  });
  const chapters = buildRouteChapters(model.events, {
    endMono: model.maxMono,
    initialUrl: manifest.site.origin
  });

  return {
    window,
    maxMono: model.maxMono,
    meta: {
      origin: manifest.site.origin,
      title: manifest.site.title ?? null,
      mode: manifest.mode,
      createdAt: manifest.createdAt,
      encrypted: Boolean(manifest.encryption),
      durationMs: model.durationMono,
      eventCount: model.events.length,
      otherTabs: tabsEvent ? model.tabsContext.summary.distinctTabs : 0,
      tabsEventId: tabsEvent?.eventId ?? null,
      hasVideo: model.screenRecordings.length > 0,
      screenshotCount: model.screenshots.length
    },
    chapters: compactChapters(chapters, window),
    densityBins: buildDensityBins(
      model.waterfall.map((entry) => ({
        startMono: entry.startMono,
        failed: entry.failed || (typeof entry.status === "number" && entry.status >= 400)
      })),
      window
    ),
    errorTicks: buildLaneTicks(
      errorEvents.map((event) => event.mono),
      window
    ),
    realtimeTicks: buildLaneTicks(
      model.realtime.map((entry) => entry.mono),
      window
    ),
    actionMarks: model.actionTimeline.map((action) => ({
      actId: action.actId,
      eventId: action.triggerEventId,
      mono: action.startMono,
      ratio: ratioOf(action.startMono, window),
      kind: classifyAction(action.triggerType),
      triggerType: action.triggerType
    })),
    problems,
    errorEvents,
    idleGaps: findIdleGaps(model.events.map((event) => event.mono))
  };
}
