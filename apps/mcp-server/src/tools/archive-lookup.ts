import type { ActionSpan, WebBlackboxPlayer } from "@webblackbox/player-sdk";
import type { WebBlackboxEvent } from "@webblackbox/protocol";
import * as z from "zod";

import { asNumber, asRecord, asString, round2 } from "./values.js";

/** Lookups shared by the drill-down tools: ids from one tool resolve in the others. */

export const anchorInputSchema = {
  mono: z
    .number()
    .finite()
    .optional()
    .describe("Session time (mono ms, as in every `mono` field). Give exactly one anchor."),
  eventId: z.string().min(1).max(512).optional().describe("Anchor on this event's time."),
  actionId: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Anchor on the start of this action (its trigger event)."),
  offsetMs: z
    .number()
    .finite()
    .min(-600_000)
    .max(600_000)
    .optional()
    .describe("Shift the anchor by this many ms (e.g. 1000 = one second after the click).")
};

export type AnchorArgs = {
  mono?: number;
  eventId?: string;
  actionId?: string;
  offsetMs?: number;
};

export type ResolvedAnchor = {
  /** The time the tool looks at: the anchor plus `offsetMs`. */
  mono: number;
  by: "mono" | "eventId" | "actionId";
  eventId: string | null;
  actionId: string | null;
  offsetMs: number;
};

export function resolveAnchor(player: WebBlackboxPlayer, args: AnchorArgs): ResolvedAnchor {
  const given = [args.mono, args.eventId, args.actionId].filter((value) => value !== undefined);
  const offsetMs = args.offsetMs ?? 0;

  if (given.length !== 1) {
    throw new Error("Give exactly one anchor: mono, eventId or actionId.");
  }

  if (args.eventId !== undefined) {
    const event = requireEvent(player, args.eventId);
    return {
      mono: event.mono + offsetMs,
      by: "eventId",
      eventId: event.id,
      actionId: event.ref?.act ?? null,
      offsetMs
    };
  }

  if (args.actionId !== undefined) {
    const span = requireActionSpan(player, args.actionId);
    return {
      mono: span.startMono + offsetMs,
      by: "actionId",
      eventId: span.triggerEventId,
      actionId: span.actId,
      offsetMs
    };
  }

  return {
    mono: (args.mono ?? 0) + offsetMs,
    by: "mono",
    eventId: null,
    actionId: null,
    offsetMs
  };
}

export function findEvent(player: WebBlackboxPlayer, eventId: string): WebBlackboxEvent | null {
  return player.events.find((event) => event.id === eventId) ?? null;
}

export function requireEvent(player: WebBlackboxPlayer, eventId: string): WebBlackboxEvent {
  const event = findEvent(player, eventId);

  if (!event) {
    throw new Error(`Unknown eventId '${eventId}': take ids from timeline or query_events.`);
  }

  return event;
}

/** The action span by id; an event id resolves to the span that holds the event. */
export function findActionSpan(player: WebBlackboxPlayer, id: string): ActionSpan | null {
  const spans = player.buildDerived().actionSpans;
  return (
    spans.find((span) => span.actId === id) ??
    spans.find((span) => span.triggerEventId === id) ??
    spans.find((span) => span.eventIds.includes(id)) ??
    null
  );
}

export function requireActionSpan(player: WebBlackboxPlayer, actionId: string): ActionSpan {
  const span = findActionSpan(player, actionId);

  if (!span) {
    throw new Error(
      `Unknown actionId '${actionId}': take ids from timeline or summarize_actions (actId).`
    );
  }

  return span;
}

export type ScreenshotRef = {
  eventId: string;
  mono: number;
  t: number;
  shotId: string | null;
  reason: string | null;
  format: string | null;
  size: number | null;
  /** Viewport of the page in CSS px when the shot was taken (the image is this × dpr). */
  viewport: { width: number; height: number; dpr: number | null } | null;
  /** Last pointer position before the shot, in viewport CSS px. */
  pointer: { x: number; y: number } | null;
};

export function listScreenshots(player: WebBlackboxPlayer): ScreenshotRef[] {
  return player.query({ types: ["screen.screenshot"] }).map((event) => {
    const data = asRecord(event.data);
    const viewport = asRecord(data?.viewport);
    const pointer = asRecord(data?.pointer);
    const width = asNumber(viewport?.width) ?? asNumber(data?.w);
    const height = asNumber(viewport?.height) ?? asNumber(data?.h);
    const x = asNumber(pointer?.x);
    const y = asNumber(pointer?.y);

    return {
      eventId: event.id,
      mono: event.mono,
      t: event.t,
      shotId: asString(data?.shotId) ?? null,
      reason: asString(data?.reason) ?? null,
      format: asString(data?.format) ?? null,
      size: asNumber(data?.size) ?? null,
      viewport:
        width !== undefined && height !== undefined
          ? { width, height, dpr: asNumber(viewport?.dpr) ?? null }
          : null,
      pointer: x !== undefined && y !== undefined ? { x, y } : null
    };
  });
}

export type NearestScreenshots = {
  nearest: ScreenshotRef | null;
  /** Latest shot at or before the time. */
  before: ScreenshotRef | null;
  /** Earliest shot after the time. */
  after: ScreenshotRef | null;
};

/** Screenshots around `mono`; `shots` in time order. */
export function findNearestScreenshots(
  shots: readonly ScreenshotRef[],
  mono: number
): NearestScreenshots {
  const before = shots.findLast((shot) => shot.mono <= mono) ?? null;
  const after = shots.find((shot) => shot.mono > mono) ?? null;
  const nearest =
    before && after
      ? mono - before.mono <= after.mono - mono
        ? before
        : after
      : (before ?? after);

  return { nearest, before, after };
}

/** A screenshot as other tools reference it: enough to decide whether to call `frame_at`. */
export function toScreenshotPointer(
  shot: ScreenshotRef,
  mono: number
): { eventId: string; mono: number; deltaMs: number; reason: string | null } {
  return {
    eventId: shot.eventId,
    mono: shot.mono,
    deltaMs: round2(shot.mono - mono),
    reason: shot.reason
  };
}
