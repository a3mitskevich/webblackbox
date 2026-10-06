import { usePlayerState } from "../../context.js";
import type { PlayerState } from "../../state.js";
import { shallowEqual } from "../../store.js";
import { inspectSelection, type Inspection } from "./inspector-model.js";

/** The target stays outlined from just before its event until this long after it. */
export const TARGET_FRAME_BEFORE_MS = 250;
export const TARGET_FRAME_AFTER_MS = 2_500;

/** The inspected target's box in the recorded viewport's CSS pixels (the stage SVG's units). */
export type InspectedTargetFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Viewport the box was measured in, when recorded (scales the outline onto the frame). */
  viewportWidth: number | null;
  viewportHeight: number | null;
};

/**
 * The inspected target's box in the top viewport, or `null` when it cannot be placed: no box, or
 * an iframe whose position the capture could not read (cross-origin parents record no offset).
 */
export function placeTarget(inspection: Inspection): InspectedTargetFrame | null {
  const target = inspection.target;
  const rect = target?.rect;

  if (!target || !rect) {
    return null;
  }

  const frameOffset = target.frameOffset ?? (inspection.inFrame ? null : { x: 0, y: 0 });

  if (!frameOffset) {
    return null;
  }

  return {
    x: rect.x + frameOffset.x,
    y: rect.y + frameOffset.y,
    width: rect.width,
    height: rect.height,
    viewportWidth: inspection.topViewport?.width ?? null,
    viewportHeight: inspection.topViewport?.height ?? null
  };
}

export function selectTargetFrame(state: PlayerState): InspectedTargetFrame | null {
  // The inspector is shown in place of the Activity list: no outline behind another rail tab.
  if (!state.detailsOpen || state.tab !== "activity" || !state.archive) {
    return null;
  }

  const inspection = inspectSelection(state.archive, state.selection);
  const frame = inspection ? placeTarget(inspection) : null;

  if (!inspection || !frame) {
    return null;
  }

  const offset = state.playheadMono - inspection.event.mono;
  return offset < -TARGET_FRAME_BEFORE_MS || offset > TARGET_FRAME_AFTER_MS ? null : frame;
}

/**
 * The target of the event open in the inspector, while the playhead is at that moment: the
 * stage draws it as a dashed outline on the video ("target + frame on the video").
 */
export function useInspectedTarget(): InspectedTargetFrame | null {
  return usePlayerState(selectTargetFrame, shallowEqual);
}
