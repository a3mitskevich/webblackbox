import { z } from "zod";

import type { CapturePolicy } from "./types.js";

/**
 * Optional pointer signals a recording profile turns on. Clicks, presses, right/middle clicks
 * and pointer geometry are always captured; these add the noisier streams.
 */
export type PointerCaptureOptions = {
  /** Dwell over interactive elements (`user.hover`). */
  hover: boolean;
  /** Pointer drags, HTML5 drag-and-drop and text selection (`user.drag.*`, `user.selection`). */
  drag: boolean;
  /** Wheel bursts and Ctrl+wheel zoom (`user.wheel`). */
  wheel: boolean;
};

export const DEFAULT_POINTER_CAPTURE_OPTIONS: PointerCaptureOptions = {
  hover: false,
  drag: false,
  wheel: false
};

/** Hold time from which a press counts as a long press (no drag). */
export const POINTER_LONG_PRESS_MS = 500;
/** Movement (CSS px) from which a held pointer counts as a drag. */
export const POINTER_DRAG_THRESHOLD_PX = 8;
/** A click this soon after a long press or drag ends is the browser's follow-up, not a new one. */
export const POINTER_FOLLOW_UP_CLICK_MS = 150;
/** Longest visible text kept on a readable target. */
export const READABLE_TARGET_TEXT_MAX_CHARS = 40;
/** Longest selected text kept on `user.selection` when the profile allows it. */
export const SELECTION_TEXT_MAX_CHARS = 200;

export type PointerKind = "mouse" | "touch" | "pen" | "unknown";

/** Viewport state at the time of a pointer action (CSS pixels). */
export type PointerViewportGeometry = {
  w: number;
  h: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
};

/** `getBoundingClientRect()` of the target, in the frame's CSS pixels. */
export type PointerTargetRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Human-readable target description, present only when the profile allows readable actions. */
export type ReadablePointerTarget = {
  role?: string;
  ariaLabel?: string;
  /** Visible text, at most `READABLE_TARGET_TEXT_MAX_CHARS` characters. */
  text?: string;
  testId?: string;
  name?: string;
  /** CSS selector that matched exactly one element at capture time. */
  css?: string;
};

export type PointerTargetPayload = {
  tag?: string;
  idToken?: string;
  classTokens?: string[];
  dataTestIdToken?: string;
  selector?: string;
  href?: string;
  rect?: PointerTargetRect;
  readable?: ReadablePointerTarget;
};

/** Fields shared by pointer actions: client and page coordinates plus frame geometry. */
export type PointerActionBase = {
  x: number;
  y: number;
  pageX?: number;
  pageY?: number;
  viewport?: PointerViewportGeometry;
  /** Offset of this frame inside the top-level viewport, when it can be read (same-origin frames). */
  frameOffset?: { x: number; y: number };
  target?: PointerTargetPayload;
};

export type PointerModifiers = {
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

export type UserPointerPressPayload = PointerActionBase &
  PointerModifiers & {
    pointerType: PointerKind;
    pointerId?: number;
    button: number;
    buttons?: number;
    /** pointerup only: time since the matching pointerdown. */
    holdMs?: number;
    /** pointerup only: held at least `POINTER_LONG_PRESS_MS` without dragging. */
    longPress?: boolean;
    /** pointerup only: straight-line distance from the pointerdown position. */
    distance?: number;
    cancelled?: boolean;
  };

export type UserClickReactionPayload = {
  /** `mono` of the click this probe followed. */
  clickMono: number;
  /** The DOM changed within the probe window. */
  mutated: boolean;
  /** Time from the click to the first DOM change. */
  latencyMs?: number;
  windowMs: number;
};

export type UserDragPayload = PointerActionBase & {
  kind: "pointer" | "dnd";
  pointerType?: PointerKind;
  /** drag.end only: where the drag started. */
  startX?: number;
  startY?: number;
  dx?: number;
  dy?: number;
  distance?: number;
  durationMs?: number;
  /** drag.end only: element under the pointer (or the drop zone) at the end. */
  dropTarget?: PointerTargetPayload;
  dropEffect?: string;
  dropped?: boolean;
  cancelled?: boolean;
};

export type UserSelectionPayload = {
  length: number;
  /** Selected text, only when the profile allows readable actions and raw DOM. */
  text?: string;
  /** The selection is inside an editable field (its text is never captured). */
  editable?: boolean;
  target?: PointerTargetPayload;
};

export type UserWheelPayload = PointerActionBase &
  PointerModifiers & {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    /** Wheel events folded into this burst. */
    count: number;
    durationMs: number;
    /** Ctrl+wheel: browser zoom or a pinch gesture on a trackpad. */
    zoom: boolean;
  };

export type UserHoverPayload = PointerActionBase & {
  dwellMs: number;
};

const finiteNumber = z.number().finite();
const looseTargetSchema = z.record(z.string(), z.unknown());

export const pointerCaptureOptionsSchema = z
  .object({
    hover: z.boolean(),
    drag: z.boolean(),
    wheel: z.boolean()
  })
  .strict();

const pointerActionBaseShape = {
  x: finiteNumber,
  y: finiteNumber,
  pageX: finiteNumber.optional(),
  pageY: finiteNumber.optional(),
  viewport: z
    .object({
      w: finiteNumber,
      h: finiteNumber,
      dpr: finiteNumber,
      scrollX: finiteNumber,
      scrollY: finiteNumber
    })
    .strict()
    .optional(),
  frameOffset: z.object({ x: finiteNumber, y: finiteNumber }).strict().optional(),
  target: looseTargetSchema.optional()
};

const modifierShape = {
  altKey: z.boolean().optional(),
  ctrlKey: z.boolean().optional(),
  shiftKey: z.boolean().optional(),
  metaKey: z.boolean().optional()
};

const pointerKindSchema = z.enum(["mouse", "touch", "pen", "unknown"]);

export const userPointerPressDataSchema = z
  .object({
    ...pointerActionBaseShape,
    ...modifierShape,
    pointerType: pointerKindSchema,
    pointerId: z.number().int().optional(),
    button: z.number().int(),
    buttons: z.number().int().optional(),
    holdMs: finiteNumber.nonnegative().optional(),
    longPress: z.boolean().optional(),
    distance: finiteNumber.nonnegative().optional(),
    cancelled: z.boolean().optional()
  })
  .strict();

export const userClickReactionDataSchema = z
  .object({
    clickMono: finiteNumber,
    mutated: z.boolean(),
    latencyMs: finiteNumber.nonnegative().optional(),
    windowMs: finiteNumber.positive()
  })
  .strict();

export const userDragDataSchema = z
  .object({
    ...pointerActionBaseShape,
    kind: z.enum(["pointer", "dnd"]),
    pointerType: pointerKindSchema.optional(),
    startX: finiteNumber.optional(),
    startY: finiteNumber.optional(),
    dx: finiteNumber.optional(),
    dy: finiteNumber.optional(),
    distance: finiteNumber.nonnegative().optional(),
    durationMs: finiteNumber.nonnegative().optional(),
    dropTarget: looseTargetSchema.optional(),
    dropEffect: z.string().max(16).optional(),
    dropped: z.boolean().optional(),
    cancelled: z.boolean().optional()
  })
  .strict();

export const userSelectionDataSchema = z
  .object({
    length: z.number().int().nonnegative(),
    text: z.string().max(SELECTION_TEXT_MAX_CHARS).optional(),
    editable: z.boolean().optional(),
    target: looseTargetSchema.optional()
  })
  .strict();

export const userWheelDataSchema = z
  .object({
    ...pointerActionBaseShape,
    ...modifierShape,
    deltaX: finiteNumber,
    deltaY: finiteNumber,
    deltaMode: z.number().int().min(0).max(2),
    count: z.number().int().positive(),
    durationMs: finiteNumber.nonnegative(),
    zoom: z.boolean()
  })
  .strict();

export const userHoverDataSchema = z
  .object({
    ...pointerActionBaseShape,
    dwellMs: finiteNumber.nonnegative()
  })
  .strict();

const READABLE_TARGET_KEYS = ["target", "dropTarget"] as const;

/** Readable pointer targets (labels, readable selectors) are kept only under `actions: "allow"`. */
export function allowsReadablePointerTargets(policy: CapturePolicy): boolean {
  return policy.categories.actions === "allow";
}

/** Selected text is page content, not just a label: it also needs `dom: "allow"`. */
export function allowsSelectionText(policy: CapturePolicy): boolean {
  return allowsReadablePointerTargets(policy) && policy.categories.dom === "allow";
}

/**
 * Drops the readable target detail and selected text a policy does not allow from a `user.*`
 * payload. Returns the payload itself when nothing had to go, otherwise a new object.
 */
export function stripUnreadablePointerDetail(
  eventType: string,
  payload: unknown,
  policy: CapturePolicy
): unknown {
  if (!eventType.startsWith("user.") || !isPlainRecord(payload)) {
    return payload;
  }

  const next: Record<string, unknown> = { ...payload };
  let changed = false;

  if (!allowsReadablePointerTargets(policy)) {
    for (const key of READABLE_TARGET_KEYS) {
      const target = payload[key];

      if (isPlainRecord(target) && "readable" in target) {
        next[key] = Object.fromEntries(
          Object.entries(target).filter(([entryKey]) => entryKey !== "readable")
        );
        changed = true;
      }
    }
  }

  if (eventType === "user.selection" && "text" in payload && !allowsSelectionText(policy)) {
    delete next.text;
    changed = true;
  }

  return changed ? next : payload;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
