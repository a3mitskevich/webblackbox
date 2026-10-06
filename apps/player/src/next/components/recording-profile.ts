import {
  readProfileCancellation,
  readRecordingProfiles,
  type ProfileCancellationInfo,
  type RecordingProfileEntry
} from "@webblackbox/player-sdk";

import type { PlayerI18n } from "../../lib/i18n.js";
import { formatRecordingProfileBanner } from "../../lib/recording-profile-view.js";
import type { LoadedArchive } from "../state.js";

export type RecordingProfileState = {
  profiles: RecordingProfileEntry[];
  cancellation: ProfileCancellationInfo | null;
};

const profileCache = new WeakMap<LoadedArchive, RecordingProfileState>();

/** The profile(s) the session was recorded with and a cancellation, read once per archive. */
export function recordingProfileOf(archive: LoadedArchive): RecordingProfileState {
  let state = profileCache.get(archive);

  if (!state) {
    state = {
      profiles: readRecordingProfiles(archive.player.events),
      cancellation: readProfileCancellation(archive.player.events)
    };
    profileCache.set(archive, state);
  }

  return state;
}

/** Banner lines for a downgraded, capped or cancelled recording profile (empty when fine). */
export function profileBannerLines(archive: LoadedArchive, i18n: PlayerI18n): string[] {
  const { profiles, cancellation } = recordingProfileOf(archive);
  return formatRecordingProfileBanner(profiles, cancellation, i18n);
}
