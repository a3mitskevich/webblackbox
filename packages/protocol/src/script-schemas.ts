import { z } from "zod";

import { SCRIPT_SOURCE_MAP_ORIGINS, SCRIPT_URL_MAX_LENGTH } from "./script.js";

// Zod schema of `sys.script`, apart from `script.ts`: page code imports the source map helpers,
// and a schema in the same module would pull zod into the page bundles.

export const scriptSourceMapDataSchema = z
  .object({
    script: z.string().min(1).max(SCRIPT_URL_MAX_LENGTH),
    sourceMap: z.string().min(1).max(SCRIPT_URL_MAX_LENGTH).optional(),
    inlineMap: z.boolean().optional(),
    origin: z.enum(SCRIPT_SOURCE_MAP_ORIGINS),
    scriptId: z.string().min(1).max(128).optional(),
    hash: z.string().min(1).max(128).optional(),
    length: z.number().int().nonnegative().optional(),
    isModule: z.boolean().optional(),
    map: z
      .object({
        contentHash: z.string().min(1),
        size: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    mapError: z.string().min(1).max(200).optional()
  })
  .strict();
