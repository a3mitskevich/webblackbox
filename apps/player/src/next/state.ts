import type { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import type { ArchiveModel } from "../core/archive-model.js";
import type { Selection } from "../core/navigation.js";
import type { ThemePreference } from "../core/preferences.js";
import type { SessionView } from "../core/session-view.js";
import type { TimeRange } from "../core/time-range.js";
import type { RailTab } from "../core/url-hash.js";
import type { PlayerLocale } from "../lib/i18n.js";

/** Where opening an archive stands; `passphrase` shows the passphrase dialog. */
export type ArchiveStatus =
  | { phase: "empty" }
  | { phase: "loading"; fileName: string }
  | { phase: "passphrase"; fileName: string; invalid: boolean }
  | { phase: "error"; fileName: string; message: string }
  | { phase: "ready" };

export type LoadedArchive = {
  fileName: string;
  player: WebBlackboxPlayer;
  model: ArchiveModel;
  view: SessionView;
  /** The archive file as opened (the Share upload sends it unchanged). */
  bytes: Uint8Array;
};

/**
 * Per-feature store slices (`features/<feature>/slice.ts`). Each feature adds its own key by
 * module augmentation, so parallel stages never edit this file:
 *
 *   declare module "../../state.js" {
 *     interface FeatureSlices { feed: FeedSlice }
 *   }
 *
 * Read and write a slice through `defineFeatureSlice` (features/slice.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by augmentation
export interface FeatureSlices {}

/** The classic player's speeds. */
export const PLAYBACK_RATES = [0.5, 1, 1.5, 2, 4] as const;

export type PlayerState = {
  locale: PlayerLocale;
  theme: ThemePreference;
  status: ArchiveStatus;
  archive: LoadedArchive | null;
  playheadMono: number;
  isPlaying: boolean;
  rate: number;
  skipIdle: boolean;
  /** Lists scroll to and highlight the playhead while playing. */
  follow: boolean;
  selection: Selection | null;
  /** The range selected on the timeline (Shift+drag, `[` / `]`); frames Generate. */
  range: TimeRange | null;
  /** "Expand lanes": the timeline shows every lane (route, navigation, console, storage…). */
  lanesExpanded: boolean;
  tab: RailTab;
  /** Text filter of the rail lists and the header search. */
  query: string;
  detailsOpen: boolean;
  /** `F`: the rail takes the whole width (the stage stays mounted, hidden). */
  railWide: boolean;
  shortcutsOpen: boolean;
  /** "About this recording": session facts and what the archive contains. */
  archiveInfoOpen: boolean;
  dragActive: boolean;
  /** Polite live-region message (jumps, loading results). */
  announcement: string;
  /** Bumped by "Reset layout": the splitters return to their default sizes. */
  layoutRevision: number;
  /** Feature state; a missing key means the feature's initial slice. */
  slices: Readonly<Partial<FeatureSlices>>;
};

export function createInitialState(locale: PlayerLocale, theme: ThemePreference): PlayerState {
  return {
    locale,
    theme,
    status: { phase: "empty" },
    archive: null,
    playheadMono: 0,
    isPlaying: false,
    rate: 1,
    skipIdle: true,
    follow: true,
    selection: null,
    range: null,
    lanesExpanded: false,
    tab: "activity",
    query: "",
    detailsOpen: false,
    railWide: false,
    shortcutsOpen: false,
    archiveInfoOpen: false,
    dragActive: false,
    announcement: "",
    layoutRevision: 0,
    slices: {}
  };
}
