import { usePlayerState } from "../../context.js";
import type { PlayerState } from "../../state.js";
import { shallowEqual } from "../../store.js";
import { inspectSelection } from "./inspector-model.js";

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

export function selectTargetFrame(state: PlayerState): InspectedTargetFrame | null {
  if (!state.detailsOpen || !state.archive) {
    return null;
  }

  const inspection = inspectSelection(state.archive, state.selection);
  const rect = inspection?.target?.rect;

  if (!inspection || !rect) {
    return null;
  }

  const offset = state.playheadMono - inspection.event.mono;

  if (offset < -TARGET_FRAME_BEFORE_MS || offset > TARGET_FRAME_AFTER_MS) {
    return null;
  }

  const frameOffset = inspection.target?.frameOffset ?? { x: 0, y: 0 };
  const viewport = inspection.target?.viewport ?? null;

  return {
    x: rect.x + frameOffset.x,
    y: rect.y + frameOffset.y,
    width: rect.width,
    height: rect.height,
    viewportWidth: frameOffset.x === 0 && frameOffset.y === 0 ? (viewport?.width ?? null) : null,
    viewportHeight: frameOffset.x === 0 && frameOffset.y === 0 ? (viewport?.height ?? null) : null
  };
}

/**
 * The target of the event open in the inspector, while the playhead is at that moment: the
 * stage draws it as a dashed outline on the video ("target + frame on the video").
 */
export function useInspectedTarget(): InspectedTargetFrame | null {
  return usePlayerState(selectTargetFrame, shallowEqual);
}
