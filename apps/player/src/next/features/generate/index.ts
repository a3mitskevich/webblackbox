import type { PlayerFeature } from "../types.js";
import { generateMessages } from "./messages.js";

/**
 * Generate: Playwright, bug report, HAR, GitHub/Jira (R5). The header renders `GenerateMenu`, the
 * app root `GenerateDialogs` (its dialogs, the generators and Shiki load on first use); other
 * features open a generator with `openGenerate(store, { kind, range })` (`api.ts`).
 */
export const generateFeature: PlayerFeature = {
  id: "generate",
  messages: generateMessages
};

export { closeGenerate, generateSlice, openGenerate } from "./api.js";
export type { GenerateKind, GenerateRequest } from "./api.js";
export { GenerateDialogs, GenerateMenu } from "./generate-entry.js";
