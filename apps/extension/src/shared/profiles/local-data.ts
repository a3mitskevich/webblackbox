import type { ProfileLocalDataSettings, RecordingProfile } from "./model.js";

const MINUTE_MS = 60_000;

/**
 * Defaults for profiles without `localData`: a successful export deletes the local copy, and a
 * stopped recording nobody exported stays on the device until it is exported or deleted (within
 * the lifetime of the at-rest key, which ends with the browser).
 */
export const DEFAULT_LOCAL_DATA_SETTINGS: Readonly<ProfileLocalDataSettings> = {
  deleteAfterExport: true
};

export function resolveLocalDataSettings(
  profile: Pick<RecordingProfile, "localData">
): ProfileLocalDataSettings {
  return { ...(profile.localData ?? DEFAULT_LOCAL_DATA_SETTINGS) };
}

/**
 * How long a stopped, unexported recording of this profile stays on the device; null keeps it
 * until it is exported or deleted.
 */
export function resolveUnexportedRetentionMs(
  profile: Pick<RecordingProfile, "localData">
): number | null {
  const minutes = resolveLocalDataSettings(profile).unexportedRetentionMinutes;
  return minutes === undefined ? null : minutes * MINUTE_MS;
}

export function isDefaultLocalDataSettings(settings: ProfileLocalDataSettings): boolean {
  return (
    settings.deleteAfterExport === DEFAULT_LOCAL_DATA_SETTINGS.deleteAfterExport &&
    settings.unexportedRetentionMinutes === DEFAULT_LOCAL_DATA_SETTINGS.unexportedRetentionMinutes
  );
}
