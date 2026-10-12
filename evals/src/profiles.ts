// The recording setups the evaluation compares: what a tester gets with one button (the Default
// profile, Lite engine) and the most complete capture (the Full capture preset).

export type RecordingProfile = {
  id: "default" | "full-capture";
  label: string;
  mode: "lite" | "full";
  /** Sent with `ui.start`; absent = whatever the profile rules pick (Default here). */
  profileId?: string;
  visualCapture?: "none" | "screenshots";
};

export const RECORDING_PROFILES: readonly RecordingProfile[] = [
  { id: "default", label: "Default profile (Lite)", mode: "lite" },
  {
    id: "full-capture",
    label: "Full capture",
    mode: "full",
    profileId: "builtin:full-capture",
    visualCapture: "screenshots"
  }
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
