// The recording setups the evaluation compares, the two built-in profiles: what a tester gets
// with one button (Maximum, the default: Full engine) and Light (page-side capture only).

export type RecordingProfile = {
  id: "maximum" | "light";
  label: string;
  mode: "lite" | "full";
  /** Sent with `ui.start`; absent = whatever the profile rules pick (Maximum here). */
  profileId?: string;
  visualCapture?: "none" | "screenshots";
};

export const RECORDING_PROFILES: readonly RecordingProfile[] = [
  // Tab video needs a click on the toolbar button (activeTab), which the harness cannot make.
  { id: "maximum", label: "Maximum (default)", mode: "full", visualCapture: "screenshots" },
  { id: "light", label: "Light", mode: "lite", profileId: "builtin:lite" }
];

export function selectProfiles(selection: readonly string[]): readonly RecordingProfile[] {
  if (selection.length === 0) {
    return RECORDING_PROFILES;
  }

  const unknown = selection.filter(
    (id) => !RECORDING_PROFILES.some((profile) => profile.id === id)
  );

  if (unknown.length > 0) {
    throw new Error(`Unknown profile(s): ${unknown.join(", ")}`);
  }

  return RECORDING_PROFILES.filter((profile) => selection.includes(profile.id));
}
