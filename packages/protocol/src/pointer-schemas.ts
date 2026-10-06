import { z } from "zod";

import { SELECTION_TEXT_MAX_CHARS } from "./pointer.js";

// Zod schemas of the pointer events, apart from `pointer.ts`: page code imports the pointer
// helpers, and a schema in the same module would pull zod into the page bundles.

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
