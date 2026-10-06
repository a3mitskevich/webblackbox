import {
  readProfileCancellation,
  readRecordingProfiles,
  type BodyCompleteness,
  type CaptureCompletenessReport,
  type ProfileCancellationInfo,
  type RecordingProfileEntry
} from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { hasPlaybackEvents } from "../lib/archive-health.js";
import type { ArchiveModel } from "./archive-model.js";

/** How completely a kind of data was recorded (● full, ◐ partial, ○ none). */
export type ContentStatus = "full" | "partial" | "none";

export type MediaContents =
  | {
      kind: "video";
      recordings: number;
      chunks: number;
      width: number | null;
      height: number | null;
      bytes: number;
    }
  | { kind: "screenshots"; count: number }
  | { kind: "none" };

/**
 * "What is in the archive" (PROPOSAL §10, borrowed from Bench): what each kind of data holds and
 * whether it is complete, so a tester can tell a usable recording from a thin one and an
 * older archive is shown honestly (cut frames, top stack frame only, bodies without reasons).
 */
export type ArchiveContents = {
  /** The archive has events the player can play (navigation, input, network, console…). */
  playable: boolean;
  media: MediaContents & { status: ContentStatus };
  network: {
    status: ContentStatus;
    requests: number;
    bodiesRequested: boolean;
    bodies: BodyCompleteness;
  };
  realtime: {
    status: ContentStatus;
    frames: number;
    sseMessages: number;
    cut: number;
    incomplete: number;
  };
  console: {
    status: ContentStatus;
    entries: number;
    errors: number;
    withStack: number;
    truncated: number;
  };
  storage: CaptureCompletenessReport["storage"] & { status: ContentStatus };
  dom: CaptureCompletenessReport["dom"] & { status: ContentStatus };
  perf: CaptureCompletenessReport["perf"] & { status: ContentStatus };
  profiles: RecordingProfileEntry[];
  cancellation: ProfileCancellationInfo | null;
};

/** DOM coverage from which the DOM counts as fully recorded. */
const DOM_FULL_COVERAGE = 0.8;

function mediaOf(model: ArchiveModel): MediaContents & { status: ContentStatus } {
  if (model.screenRecordings.length > 0) {
    const first = model.screenRecordings[0];
    return {
      kind: "video",
      status: "full",
      recordings: model.screenRecordings.length,
      chunks: model.screenRecordings.reduce((total, entry) => total + entry.chunkCount, 0),
      width: first?.width ?? null,
      height: first?.height ?? null,
      bytes: model.screenRecordings.reduce((total, entry) => total + (entry.size ?? 0), 0)
    };
  }

  return model.screenshots.length > 0
    ? { kind: "screenshots", status: "full", count: model.screenshots.length }
    : { kind: "none", status: "none" };
}

export function buildArchiveContents(
  events: readonly WebBlackboxEvent[],
  model: ArchiveModel,
  report: CaptureCompletenessReport
): ArchiveContents {
  const { network, realtime, console, storage, dom, perf } = report;
  const bodies = network.responseBodies;
  const frames = realtime.wsFrames;
  const storageValues = storage.cookieValues + storage.localValues + storage.idbRecords;
  const storageSnapshots = storage.cookieSnapshots + storage.localSnapshots + storage.idbSnapshots;
  const domEvents = dom.snapshots + dom.mutationBatches + dom.rrwebEvents;

  return {
    playable: hasPlaybackEvents([...events]),
    media: mediaOf(model),
    network: {
      status:
        network.requests === 0
          ? "none"
          : !report.bodiesRequested || bodies.skipped + bodies.missing + bodies.truncated > 0
            ? "partial"
            : "full",
      requests: network.requests,
      bodiesRequested: report.bodiesRequested,
      bodies
    },
    realtime: {
      status:
        frames + realtime.sseMessages === 0
          ? "none"
          : realtime.truncatedFrames + realtime.incompleteFrames > 0
            ? "partial"
            : "full",
      frames,
      sseMessages: realtime.sseMessages,
      cut: realtime.truncatedFrames,
      incomplete: realtime.incompleteFrames
    },
    console: {
      status:
        console.entries === 0
          ? "none"
          : console.withStack < console.errors || console.truncated > 0
            ? "partial"
            : "full",
      ...console
    },
    storage: {
      ...storage,
      status: storageSnapshots === 0 ? "none" : storageValues === 0 ? "partial" : "full"
    },
    dom: {
      ...dom,
      status: domEvents === 0 ? "none" : dom.coverage < DOM_FULL_COVERAGE ? "partial" : "full"
    },
    perf: {
      ...perf,
      status: perf.vitals + perf.longTasks + perf.traces === 0 ? "none" : "full"
    },
    profiles: readRecordingProfiles(events),
    cancellation: readProfileCancellation(events)
  };
}
