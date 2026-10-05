import type { CaptureMode } from "@webblackbox/protocol";

import type { RecordingProfile } from "./model.js";

/**
 * What only the Full (CDP) engine records. The Lite engine drops it without a trace, so a profile
 * asking for any of it starts only in Full. Read from what the profile captures, never from its
 * id, so an edited copy of a preset behaves like the preset.
 */
const FULL_ENGINE_ONLY: ReadonlyArray<(profile: RecordingProfile) => boolean> = [
  // Request and response bodies, WebSocket message payloads.
  (profile) => profile.categories.network === "body-allowlist",
  (profile) => profile.categories.screenshots !== "off",
  (profile) => profile.categories.screenRecordings === "allow",
  // Whole console messages with their stacks; Lite keeps a truncated summary.
  (profile) => profile.categories.console === "allow",
  (profile) => profile.categories.cdp !== "off",
  // A pinned visual capture (screenshots, tab video) only runs in Full.
  (profile) => profile.visual !== undefined && profile.visual !== "none"
];

export function requiresFullEngine(profile: RecordingProfile): boolean {
  return FULL_ENGINE_ONLY.some((needsFull) => needsFull(profile));
}

/**
 * Whether Start must use Full for a selected profile. The legacy Default (v1 options, no profiles
 * saved yet) keeps today's behaviour: v1 options were always applied in either engine.
 */
export function selectionRequiresFullEngine(selection: {
  profile: RecordingProfile;
  legacy: boolean;
}): boolean {
  return !selection.legacy && requiresFullEngine(selection.profile);
}

/** The engine a recording runs in: Full when the profile needs it, else the requested one. */
export function resolveStartEngine(
  requested: CaptureMode,
  selection: { profile: RecordingProfile; legacy: boolean }
): CaptureMode {
  return selectionRequiresFullEngine(selection) ? "full" : requested;
}
