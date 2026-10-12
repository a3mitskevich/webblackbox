/**
 * The toolbar badge. One badge serves every notice, so the most urgent one wins:
 *
 * 1. `REC` while any tab records, `LITE` while a recording left Full and goes on in Light;
 * 2. `ERR` for `FREEZE_BADGE_HIGHLIGHT_MS` after a freeze (then it falls back down this list);
 * 3. `!` while a profile-change notice is unread;
 * 4. `SAVE` while a stopped recording waits for its export;
 * 5. the idle notice (the "newer extension version" arrow) when one is set;
 * 6. no badge.
 */

const FREEZE_BADGE_HIGHLIGHT_MS = 15_000;

export type BadgeSpec = { text: string; color: string };

const RECORDING_BADGE: BadgeSpec = { text: "REC", color: "#c92a2a" };
const FREEZE_BADGE: BadgeSpec = { text: "ERR", color: "#9b2226" };
const DEGRADED_RECORDING_BADGE: BadgeSpec = { text: "LITE", color: "#b35c00" };
const PROFILE_CHANGE_BADGE: BadgeSpec = { text: "!", color: "#b35c00" };
const EXPORT_PENDING_BADGE: BadgeSpec = { text: "SAVE", color: "#2b8a3e" };

type ActionLike = {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
};

export type ActionBadgeDeps = {
  action: ActionLike | undefined;
  isRecording: () => boolean;
  /** A recording fell back from Full to Light. */
  isRecordingDegraded?: () => boolean;
  hasUnreadProfileNotice: () => boolean;
  /** A stopped recording waits for its export (the popup's export step). */
  hasPendingExport?: () => boolean;
  /** The lowest-priority badge, shown when nothing else claims the badge. */
  idleNotice?: () => Promise<BadgeSpec | null>;
};

export type ActionBadgeController = {
  /** No recording: the idle notice, or no badge. */
  setIdle: () => Promise<void>;
  setRecording: () => Promise<void>;
  /** `ERR` for a while, then whatever `refresh` picks. */
  setFreeze: () => Promise<void>;
  /** Applies the list above. */
  refresh: () => Promise<void>;
  /** Like `refresh`, but leaves a running freeze highlight alone: it re-applies the list itself. */
  refreshUnlessHighlighted: () => Promise<void>;
};

export function createActionBadge(deps: ActionBadgeDeps): ActionBadgeController {
  let freezeBadgeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every badge request; an idle notice read in the meantime is stale. */
  let latestRequest = 0;

  function claim(): number {
    latestRequest += 1;
    return latestRequest;
  }

  async function apply(badge: BadgeSpec | null, label: string): Promise<void> {
    await deps.action?.setBadgeText({ text: badge?.text ?? "" }).catch((error) => {
      console.warn(`[WebBlackbox] failed to set the ${label} badge`, error);
    });

    if (badge) {
      await deps.action?.setBadgeBackgroundColor({ color: badge.color }).catch((error) => {
        console.warn(`[WebBlackbox] failed to set the ${label} badge color`, error);
      });
    }
  }

  async function setIdle(): Promise<void> {
    const request = claim();
    const notice = await deps.idleNotice?.().catch(() => null);

    // REC or ERR may have been set while the notice was read: do not overwrite them.
    if (request !== latestRequest) {
      return;
    }

    await apply(notice ?? null, notice ? "idle notice" : "idle");
  }

  async function setRecording(): Promise<void> {
    claim();
    await apply(
      deps.isRecordingDegraded?.() ? DEGRADED_RECORDING_BADGE : RECORDING_BADGE,
      "recording"
    );
  }

  async function setFreeze(): Promise<void> {
    claim();
    await apply(FREEZE_BADGE, "freeze");

    if (freezeBadgeTimer !== null) {
      clearTimeout(freezeBadgeTimer);
    }

    freezeBadgeTimer = setTimeout(() => {
      freezeBadgeTimer = null;
      void refresh();
    }, FREEZE_BADGE_HIGHLIGHT_MS);
  }

  async function refresh(): Promise<void> {
    if (deps.isRecording()) {
      await setRecording();
      return;
    }

    if (deps.hasUnreadProfileNotice()) {
      claim();
      await apply(PROFILE_CHANGE_BADGE, "profile-change");
      return;
    }

    if (deps.hasPendingExport?.()) {
      claim();
      await apply(EXPORT_PENDING_BADGE, "export-pending");
      return;
    }

    await setIdle();
  }

  async function refreshUnlessHighlighted(): Promise<void> {
    if (freezeBadgeTimer === null) {
      await refresh();
    }
  }

  return { setIdle, setRecording, setFreeze, refresh, refreshUnlessHighlighted };
}
