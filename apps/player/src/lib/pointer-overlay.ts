import type {
  PointerActionKind,
  PointerSignals,
  PointerTimelineEntry
} from "@webblackbox/player-sdk";

import { escapeHtml } from "./dom.js";

/** How long a click ripple stays on the stage after the click. */
export const RIPPLE_WINDOW_MS = 1_200;
/** Most marks drawn on the pointer lane; denser sessions keep the most telling mark per slot. */
export const POINTER_LANE_MAX_MARKS = 160;

const RIPPLE_MIN_RADIUS = 6;
const RIPPLE_MAX_RADIUS = 26;
const RIPPLE_KINDS = new Set<PointerActionKind>([
  "click",
  "double",
  "right",
  "middle",
  "hold",
  "drag",
  "dnd"
]);

export type PointerLaneKind = PointerActionKind | "rage" | "dead";

/** Pointer action in top-frame viewport coordinates. */
export type OverlayPointerAction = {
  mono: number;
  kind: PointerActionKind;
  x: number;
  y: number;
  startX?: number;
  startY?: number;
};

export type RippleMark = OverlayPointerAction & {
  /** 0 right at the action, 1 when the ripple fades out. */
  progress: number;
};

export type PointerLaneMark = {
  mono: number;
  kind: PointerLaneKind;
  /** Visual group: plain clicks, other buttons/holds, gestures, problems. */
  tone: "click" | "alt" | "gesture" | "problem";
  label: string;
  eventId?: string;
};

/** Rendered stage box and the viewport size the coordinates were recorded in. */
export type OverlayFrame = {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
};

const LANE_PRIORITY: Record<PointerLaneKind, number> = {
  rage: 6,
  dead: 5,
  right: 4,
  hold: 4,
  double: 4,
  middle: 4,
  drag: 3,
  dnd: 3,
  zoom: 2,
  click: 1,
  wheel: 0,
  hover: 0,
  selection: 0
};

const LANE_TONE: Record<PointerLaneKind, PointerLaneMark["tone"]> = {
  rage: "problem",
  dead: "problem",
  right: "alt",
  hold: "alt",
  double: "alt",
  middle: "alt",
  drag: "gesture",
  dnd: "gesture",
  zoom: "gesture",
  wheel: "gesture",
  hover: "gesture",
  selection: "gesture",
  click: "click"
};

/** Stage-drawable actions (clicks, presses, drags) in top-frame coordinates. */
export function toOverlayActions(
  timeline: readonly PointerTimelineEntry[]
): OverlayPointerAction[] {
  const actions: OverlayPointerAction[] = [];

  for (const entry of timeline) {
    if (!RIPPLE_KINDS.has(entry.kind) || entry.x === undefined || entry.y === undefined) {
      continue;
    }

    const offsetX = entry.frameOffset?.x ?? 0;
    const offsetY = entry.frameOffset?.y ?? 0;

    actions.push({
      mono: entry.mono,
      kind: entry.kind,
      x: entry.x + offsetX,
      y: entry.y + offsetY,
      ...(entry.startX !== undefined && entry.startY !== undefined
        ? { startX: entry.startX + offsetX, startY: entry.startY + offsetY }
        : {})
    });
  }

  return actions.sort((left, right) => left.mono - right.mono);
}

/** Ripples for actions in the `windowMs` before the playhead, oldest first. */
export function buildRippleMarks(
  actions: readonly OverlayPointerAction[],
  playheadMono: number,
  windowMs = RIPPLE_WINDOW_MS
): RippleMark[] {
  const marks: RippleMark[] = [];

  for (let index = upperBound(actions, playheadMono) - 1; index >= 0; index -= 1) {
    const action = actions[index];

    if (!action) {
      continue;
    }

    const age = playheadMono - action.mono;

    if (age > windowMs) {
      break;
    }

    marks.unshift({ ...action, progress: Math.min(1, Math.max(0, age / windowMs)) });
  }

  return marks;
}

/**
 * Marks for the pointer lane: every timeline action plus rage and dead clicks. When there are
 * more than `maxMarks`, the lane is split into equal slots and each keeps its most telling mark.
 */
export function buildPointerLaneMarks(
  timeline: readonly PointerTimelineEntry[],
  signals: PointerSignals,
  labelFor: (kind: PointerLaneKind) => string,
  maxMarks = POINTER_LANE_MAX_MARKS
): PointerLaneMark[] {
  const marks: PointerLaneMark[] = [
    ...timeline.map((entry) =>
      toLaneMark(entry.mono, entry.kind, labelFor, entry.target, entry.eventId)
    ),
    ...signals.rageClicks.map((finding) =>
      toLaneMark(finding.startMono, "rage", labelFor, finding.target, finding.eventIds[0])
    ),
    ...signals.deadClicks.map((finding) =>
      toLaneMark(finding.mono, "dead", labelFor, finding.target, finding.eventId)
    )
  ].sort((left, right) => left.mono - right.mono);

  if (marks.length <= maxMarks) {
    return marks;
  }

  const first = marks[0]?.mono ?? 0;
  const span = Math.max(1, (marks[marks.length - 1]?.mono ?? first) - first);
  const slots = new Map<number, PointerLaneMark>();

  for (const mark of marks) {
    const slot = Math.min(maxMarks - 1, Math.floor(((mark.mono - first) / span) * maxMarks));
    const kept = slots.get(slot);

    if (!kept || LANE_PRIORITY[mark.kind] > LANE_PRIORITY[kept.kind]) {
      slots.set(slot, mark);
    }
  }

  return [...slots.values()].sort((left, right) => left.mono - right.mono);
}

/** Maps recorded viewport coordinates onto the stage (media letterboxed with `contain`). */
export function projectOverlayPoint(
  frame: OverlayFrame,
  x: number,
  y: number
): { x: number; y: number } {
  const scale = Math.min(frame.width / frame.sourceWidth, frame.height / frame.sourceHeight);
  const renderedWidth = frame.sourceWidth * scale;
  const renderedHeight = frame.sourceHeight * scale;
  const offsetX = (frame.width - renderedWidth) / 2;
  const offsetY = (frame.height - renderedHeight) / 2;

  return {
    x: offsetX + (x / frame.sourceWidth) * renderedWidth,
    y: offsetY + (y / frame.sourceHeight) * renderedHeight
  };
}

/** SVG markup for ripples, drag paths and short labels ("right", "hold", ...). */
export function renderRippleSvg(
  marks: readonly RippleMark[],
  frame: OverlayFrame,
  labelFor: (kind: PointerActionKind) => string | null
): string {
  return marks
    .map((mark) => {
      const point = projectOverlayPoint(frame, mark.x, mark.y);
      const radius = RIPPLE_MIN_RADIUS + (RIPPLE_MAX_RADIUS - RIPPLE_MIN_RADIUS) * mark.progress;
      const opacity = (1 - mark.progress).toFixed(3);
      const kindClass = `preview-ripple-${mark.kind}`;
      const path =
        mark.startX !== undefined && mark.startY !== undefined
          ? (() => {
              const start = projectOverlayPoint(frame, mark.startX, mark.startY);
              return `<line class="preview-drag-path" x1="${fixed(start.x)}" y1="${fixed(start.y)}" x2="${fixed(point.x)}" y2="${fixed(point.y)}" opacity="${opacity}"></line>`;
            })()
          : "";
      const ring = `<circle class="preview-ripple ${kindClass}" cx="${fixed(point.x)}" cy="${fixed(point.y)}" r="${fixed(radius)}" opacity="${opacity}"></circle>`;
      const second =
        mark.kind === "double"
          ? `<circle class="preview-ripple ${kindClass}" cx="${fixed(point.x)}" cy="${fixed(point.y)}" r="${fixed(radius * 0.6)}" opacity="${opacity}"></circle>`
          : "";
      const label = labelFor(mark.kind);
      const text = label
        ? `<text class="preview-ripple-label" x="${fixed(point.x + RIPPLE_MAX_RADIUS * 0.6)}" y="${fixed(point.y - RIPPLE_MAX_RADIUS * 0.6)}" opacity="${opacity}">${escapeHtml(label)}</text>`
        : "";

      return `${path}${ring}${second}${text}`;
    })
    .join("");
}

function toLaneMark(
  mono: number,
  kind: PointerLaneKind,
  labelFor: (kind: PointerLaneKind) => string,
  target: string | undefined,
  eventId: string | undefined
): PointerLaneMark {
  return {
    mono,
    kind,
    tone: LANE_TONE[kind],
    label: target ? `${labelFor(kind)}: ${target}` : labelFor(kind),
    ...(eventId ? { eventId } : {})
  };
}

function upperBound(actions: readonly OverlayPointerAction[], mono: number): number {
  let low = 0;
  let high = actions.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((actions[middle]?.mono ?? Number.POSITIVE_INFINITY) <= mono) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function fixed(value: number): string {
  return value.toFixed(2);
}
