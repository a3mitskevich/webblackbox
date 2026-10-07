import type { TimeRange } from "../../../core/time-range.js";
import type { PlayerState } from "../../state.js";
import type { Store } from "../../store.js";
import { defineFeatureSlice } from "../slice.js";

/** What the Generate menu produces (PROPOSAL §1 scenario 9). */
export type GenerateKind =
  "playwright" | "playwright-mocks" | "bug-report" | "har" | "github-issue" | "jira-issue";

/** A request to open one generator; `range` frames it (default: the timeline range, else all). */
export type GenerateRequest = {
  kind: GenerateKind;
  range?: TimeRange | null;
};

export type GenerateSlice = {
  /** The open generator dialog, or `null`. */
  request: GenerateRequest | null;
};

declare module "../../state.js" {
  interface FeatureSlices {
    generate: GenerateSlice;
  }
}

export const generateSlice = defineFeatureSlice("generate", { request: null });

/**
 * Opens a generator dialog from anywhere (header menu, event inspector, command palette). Without
 * an explicit range the dialog starts from the timeline range.
 */
export function openGenerate(store: Store<PlayerState>, request: GenerateRequest): void {
  generateSlice.update(store, () => ({ request }));
}

export function closeGenerate(store: Store<PlayerState>): void {
  generateSlice.update(store, (slice) => (slice.request ? { request: null } : slice));
}
