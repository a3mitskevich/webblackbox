/**
 * The toolbar badge. One badge serves every notice, so the most urgent one wins:
 *
 * 1. `REC` while any tab records;
 * 2. `ERR` for `FREEZE_BADGE_HIGHLIGHT_MS` after a freeze (then it falls back down this list);
 * 3. `!` while a profile-change notice is unread;
 * 4. the idle notice (the "newer extension version" arrow) when one is set;
 * 5. no badge.
 */

const FREEZE_BADGE_HIGHLIGHT_MS = 15_000;

export type BadgeSpec = { text: string; color: string };

const RECORDING_BADGE: BadgeSpec = { text: "REC", color: "#c92a2a" };
const FREEZE_BADGE: BadgeSpec = { text: "ERR", color: "#9b2226" };
const PROFILE_CHANGE_BADGE: BadgeSpec = { text: "!", color: "#b35c00" };

type ActionLike = {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
};

export type ActionBadgeDeps = {
  action: ActionLike | undefined;
  isRecording: () => boolean;
  hasUnreadProfileNotice: () => boolean;
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
    const notice = await deps.idleNotice?.().catch(() => null);
    await apply(notice ?? null, notice ? "idle notice" : "idle");
  }

  async function setRecording(): Promise<void> {
    await apply(RECORDING_BADGE, "recording");
  }

  async function setFreeze(): Promise<void> {
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
      await apply(PROFILE_CHANGE_BADGE, "profile-change");
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
