import * as z from "zod";

import {
  A11Y_SNAPSHOT_LIMITS,
  A11Y_SNAPSHOT_MASKING_LEVELS,
  A11Y_SNAPSHOT_TRIGGER_KINDS
} from "./a11y.js";

// Zod schema of `dom.a11y.snapshot`, apart from `a11y.ts`: page code imports the format helpers,
// and a schema in the same module would pull zod into the page bundles.

const finiteNumber = z.number().finite();
const count = z.number().int().nonnegative();
/** The cut marker line may follow a tree at the size limit. */
const MAX_TREE_TEXT_CHARS = A11Y_SNAPSHOT_LIMITS.maxTreeChars + 256;

export const a11ySnapshotTriggerSchema = z
  .object({
    kind: z.enum(A11Y_SNAPSHOT_TRIGGER_KINDS),
    rawType: z.string().min(1).max(64).optional(),
    eventId: z.string().min(1).max(256).optional(),
    coalesced: count.optional(),
    delayMs: finiteNumber.nonnegative().optional()
  })
  .strict();

export const domA11ySnapshotDataSchema = z
  .object({
    trigger: a11ySnapshotTriggerSchema,
    url: z.string().max(A11Y_SNAPSHOT_LIMITS.maxUrlChars),
    title: z.string().max(A11Y_SNAPSHOT_LIMITS.maxUrlChars).optional(),
    viewport: z
      .object({
        w: finiteNumber.nonnegative(),
        h: finiteNumber.nonnegative(),
        scrollX: finiteNumber,
        scrollY: finiteNumber
      })
      .strict(),
    scope: z.literal("viewport"),
    tree: z.string().max(MAX_TREE_TEXT_CHARS),
    nodeCount: count,
    omittedNodes: count,
    truncated: z.boolean(),
    masking: z.enum(A11Y_SNAPSHOT_MASKING_LEVELS),
    frames: count.optional(),
    droppedTriggers: count.optional(),
    durationMs: finiteNumber.nonnegative()
  })
  .strict();
