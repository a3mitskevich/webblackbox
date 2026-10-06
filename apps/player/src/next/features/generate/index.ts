import type { PlayerFeature } from "../types.js";

/**
 * Generate: Playwright, bug report, HAR, GitHub/Jira (R5). The header renders `GenerateMenu`, the
 * app root `GenerateDialogs`; other features open a generator with `openGenerate` (`api.ts`).
 */
export const generateFeature: PlayerFeature = {
  id: "generate"
};

export { closeGenerate, generateSlice, openGenerate } from "./api.js";
export type { GenerateKind, GenerateRequest } from "./api.js";
export { GenerateDialogs, GenerateMenu } from "./generate-entry.js";
