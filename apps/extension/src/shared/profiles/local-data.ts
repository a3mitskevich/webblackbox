import type { ProfileLocalDataSettings, RecordingProfile } from "./model.js";

const MINUTE_MS = 60_000;

/**
 * Defaults for profiles without `localData`. Every successful export already deleted its
 * recording before this setting existed, and a stopped recording was kept for 10 minutes; both
 * stay the default so no profile keeps data longer than it used to.
 */
export const DEFAULT_LOCAL_DATA_SETTINGS: Readonly<ProfileLocalDataSettings> = {
  deleteAfterExport: true,
  unexportedRetentionMinutes: 10
};

/** Full capture records content raw, so its unexported recordings are kept for less time. */
export const FULL_CAPTURE_LOCAL_DATA_SETTINGS: Readonly<ProfileLocalDataSettings> = {
  deleteAfterExport: true,
  unexportedRetentionMinutes: 5
};

export function resolveLocalDataSettings(
  profile: Pick<RecordingProfile, "localData">
): ProfileLocalDataSettings {
  return { ...(profile.localData ?? DEFAULT_LOCAL_DATA_SETTINGS) };
}

/** How long a stopped, unexported recording of this profile stays on the device. */
export function resolveUnexportedRetentionMs(profile: Pick<RecordingProfile, "localData">): number {
  return resolveLocalDataSettings(profile).unexportedRetentionMinutes * MINUTE_MS;
}

export function isDefaultLocalDataSettings(settings: ProfileLocalDataSettings): boolean {
  return (
    settings.deleteAfterExport === DEFAULT_LOCAL_DATA_SETTINGS.deleteAfterExport &&
    settings.unexportedRetentionMinutes === DEFAULT_LOCAL_DATA_SETTINGS.unexportedRetentionMinutes
  );
}
