import { DEFAULT_CAPTURE_POLICY, type CapturePolicy } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  FULL_MODE_SKIPPED_RAW_TYPES,
  isPageEventKeptInFullMode,
  shouldPageCapture
} from "./capture-scope.js";

type Categories = CapturePolicy["categories"];

/**
 * Every raw type that appeared in either of the two pre-unification full-mode skip lists:
 * the extension service worker's `SKIPPED_FULL_MODE_CONTENT_RAW_TYPES` (18 entries) and the
 * capture agent's `FULL_MODE_SKIPPED_RAW_TYPES` (7 entries). The agent's list is now the
 * single decision (`shouldPageCapture`), applied at the source.
 */
const SW_ONLY_RAW_TYPES = [
  "networkBody",
  "fetch",
  "xhr",
  "fetchError",
  "console",
  "pageError",
  "unhandledrejection",
  "resourceError",
  "sse",
  "notice",
  "script"
];
const SHARED_SKIPPED_RAW_TYPES = [
  "scroll",
  "mutation",
  "snapshot",
  "screenshot",
  "localStorageSnapshot",
  "indexedDbSnapshot",
  "cookieSnapshot"
];

function categoriesWith(overrides: Partial<Categories>): Categories {
  return {
    ...DEFAULT_CAPTURE_POLICY.categories,
    ...overrides
  };
}

describe("shouldPageCapture", () => {
  it("captures every raw type in lite mode, whatever the profile", () => {
    for (const rawType of [...SHARED_SKIPPED_RAW_TYPES, ...SW_ONLY_RAW_TYPES]) {
      expect(shouldPageCapture(rawType, "lite", DEFAULT_CAPTURE_POLICY.categories)).toBe(true);
      expect(shouldPageCapture(rawType, "lite", categoriesWith({ dom: "allow" }))).toBe(true);
    }
  });

  it("captures every raw type outside full mode (freeze indicator state included)", () => {
    for (const rawType of SHARED_SKIPPED_RAW_TYPES) {
      expect(shouldPageCapture(rawType, "freeze", DEFAULT_CAPTURE_POLICY.categories)).toBe(true);
      expect(shouldPageCapture(rawType, undefined, DEFAULT_CAPTURE_POLICY.categories)).toBe(true);
    }
  });

  it("drops scroll and screenshot in full mode under every category combination", () => {
    const combos: Categories[] = [
      DEFAULT_CAPTURE_POLICY.categories,
      categoriesWith({ dom: "allow" }),
      categoriesWith({ storage: "allow", indexedDb: "allow", cookies: "allow" }),
      categoriesWith({ screenshots: "allow" })
    ];

    for (const categories of combos) {
      expect(shouldPageCapture("scroll", "full", categories)).toBe(false);
      expect(shouldPageCapture("screenshot", "full", categories)).toBe(false);
    }
  });

  it("drops snapshot and mutation in full mode unless dom: allow asks for the raw page", () => {
    for (const rawType of ["snapshot", "mutation"]) {
      expect(shouldPageCapture(rawType, "full", DEFAULT_CAPTURE_POLICY.categories)).toBe(false);
      expect(shouldPageCapture(rawType, "full", categoriesWith({ dom: "masked" }))).toBe(false);
      expect(shouldPageCapture(rawType, "full", categoriesWith({ dom: "off" }))).toBe(false);
      expect(shouldPageCapture(rawType, "full", categoriesWith({ dom: "allow" }))).toBe(true);
    }
  });

  it("drops storage snapshots in full mode while the profile keeps counts only", () => {
    for (const rawType of ["localStorageSnapshot", "indexedDbSnapshot", "cookieSnapshot"]) {
      expect(shouldPageCapture(rawType, "full", DEFAULT_CAPTURE_POLICY.categories)).toBe(false);
    }
  });

  it("keeps storage snapshots in full mode when the profile asks for storage details", () => {
    const detailed = categoriesWith({ storage: "names-only" });
    expect(shouldPageCapture("localStorageSnapshot", "full", detailed)).toBe(true);
    expect(shouldPageCapture("indexedDbSnapshot", "full", detailed)).toBe(true);
    expect(shouldPageCapture("cookieSnapshot", "full", detailed)).toBe(true);

    expect(
      shouldPageCapture("indexedDbSnapshot", "full", categoriesWith({ indexedDb: "allow" }))
    ).toBe(true);
    expect(
      shouldPageCapture("cookieSnapshot", "full", categoriesWith({ cookies: "names-only" }))
    ).toBe(true);
    expect(
      shouldPageCapture("localStorageSnapshot", "full", categoriesWith({ storage: "counts-only" }))
    ).toBe(false);
  });

  it("captures in full mode what only the old service-worker list dropped (agent decision wins)", () => {
    // The SW used to drop these page-side events a second time; with one shared decision the
    // agent's list governs, and the agent never skipped them (the injected hooks stay inactive
    // or storage-only in full mode, so they do not reach the agent anyway).
    for (const rawType of SW_ONLY_RAW_TYPES) {
      expect(shouldPageCapture(rawType, "full", DEFAULT_CAPTURE_POLICY.categories)).toBe(true);
      expect(shouldPageCapture(rawType, "full", categoriesWith({ dom: "allow" }))).toBe(true);
    }
  });

  it("keeps the skip list exactly at the seven shared entries", () => {
    expect([...FULL_MODE_SKIPPED_RAW_TYPES].sort()).toEqual([...SHARED_SKIPPED_RAW_TYPES].sort());
  });

  it("stays consistent with isPageEventKeptInFullMode for skipped types", () => {
    const combos: Categories[] = [
      DEFAULT_CAPTURE_POLICY.categories,
      categoriesWith({ dom: "allow" }),
      categoriesWith({ storage: "allow", indexedDb: "allow", cookies: "allow" })
    ];

    for (const categories of combos) {
      for (const rawType of SHARED_SKIPPED_RAW_TYPES) {
        expect(shouldPageCapture(rawType, "full", categories)).toBe(
          isPageEventKeptInFullMode(rawType, categories)
        );
      }
    }
  });
});
