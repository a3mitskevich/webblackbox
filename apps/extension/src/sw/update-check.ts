import {
  EXTENSION_UPDATE_DISMISSED_STORAGE_KEY,
  EXTENSION_UPDATE_STORAGE_KEY,
  loadExtensionUpdateNotice,
  normalizeExtensionUpdateState,
  parseExtensionMetadataVersion,
  resolveExtensionMetadataUrl
} from "../shared/extension-update.js";
import { PLAYER_URL_STORAGE_KEY } from "../shared/player-url.js";
import type { BadgeSpec } from "./action-badge.js";

/**
 * Service-worker side of the update notice: asks the configured Player which extension version it
 * ships and remembers the answer for the badge and the popup. A plain GET to the Player's origin
 * with no credentials, no referrer and no redirects; nothing about the user is sent. Without a
 * Player URL nothing is requested. In the `store-safe` build (no host permissions) the request is
 * cross-origin and fails unless the Player allows CORS; that, like any other failure, is silent:
 * the last known answer stays.
 */

export const EXTENSION_UPDATE_ALARM = "webblackbox.extension-update-check";
export const EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES = 6 * 60;
const METADATA_FETCH_TIMEOUT_MS = 10_000;

/** Language-neutral, so the worker needs no locale; lowest priority (see `action-badge.ts`). */
export const UPDATE_AVAILABLE_BADGE: BadgeSpec = { text: "↑", color: "#1667b8" };

type StorageLocalLike = {
  get(keys?: string[] | string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
};

type UpdateAlarmsLike = {
  get?(name: string): Promise<{ name: string; periodInMinutes?: number } | undefined>;
  create(
    name: string,
    alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }
  ): Promise<void> | void;
};

export type ExtensionUpdateCheckDeps = {
  storageLocal: StorageLocalLike | undefined;
  alarms: UpdateAlarmsLike | undefined;
  /**
   * The effective Player URL, "" when none is configured, null when that is unknown (the policy
   * did not answer). Must not throw.
   */
  loadPlayerUrl: () => Promise<string | null>;
  fetch: typeof fetch | undefined;
  installedVersion: string;
  now: () => number;
  /** Re-applies the action badge after the notice changed. */
  refreshBadge: () => Promise<void>;
  fetchTimeoutMs?: number;
};

export type ExtensionUpdateChecker = {
  /** Checks the Player now, or right after the check in flight. Never rejects. */
  check: () => Promise<void>;
  /** Creates the periodic alarm unless it already exists (re-creating would postpone it). */
  ensureAlarm: () => Promise<void>;
  /** The update badge while a newer, not dismissed version is known; null otherwise. */
  badge: () => Promise<BadgeSpec | null>;
  /** `storage.onChanged`: a new Player URL re-checks, a new answer or dismissal re-badges. */
  handleStorageChange: (changes: Record<string, unknown>, areaName: string) => void;
};

export function createExtensionUpdateChecker(
  deps: ExtensionUpdateCheckDeps
): ExtensionUpdateChecker {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  /**
   * One check at a time. A request during a check runs once more after it: the running one may
   * have read the Player URL before the change that asked for this one.
   */
  function check(): Promise<void> {
    if (!running) {
      running = runCheck()
        .catch((error: unknown) => {
          console.debug("[WebBlackbox] extension update check failed", error);
        })
        .finally(() => {
          running = null;
        });
      return running;
    }

    queued ??= running.then(() => {
      queued = null;
      return check();
    });
    return queued;
  }

  async function runCheck(): Promise<void> {
    try {
      const playerUrl = await deps.loadPlayerUrl();

      // Unknown is not "none": forgetting here would drop a policy Player's answer.
      if (playerUrl === null) {
        return;
      }

      const latestVersion = playerUrl ? await fetchLatestVersion(playerUrl) : null;

      if (latestVersion) {
        await deps.storageLocal?.set({
          [EXTENSION_UPDATE_STORAGE_KEY]: { latestVersion, checkedAt: deps.now(), playerUrl }
        });
      } else {
        await forgetAnswerFromOtherPlayer(playerUrl);
      }
    } finally {
      await deps.refreshBadge();
    }
  }

  /** A failed check keeps the last answer, unless it came from a Player no longer configured. */
  async function forgetAnswerFromOtherPlayer(playerUrl: string): Promise<void> {
    const values = await deps.storageLocal?.get(EXTENSION_UPDATE_STORAGE_KEY);
    const stored = normalizeExtensionUpdateState(values?.[EXTENSION_UPDATE_STORAGE_KEY]);

    if (stored && stored.playerUrl !== playerUrl) {
      await deps.storageLocal?.remove?.(EXTENSION_UPDATE_STORAGE_KEY);
    }
  }

  async function fetchLatestVersion(playerUrl: string): Promise<string | null> {
    const url = resolveExtensionMetadataUrl(playerUrl);

    if (!url || !deps.fetch) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, deps.fetchTimeoutMs ?? METADATA_FETCH_TIMEOUT_MS);

    try {
      const response = await deps.fetch(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });

      return response.ok ? parseExtensionMetadataVersion(await response.json()) : null;
    } catch (error) {
      // Offline, no file, CORS in store-safe, bad JSON: the notice is best effort.
      console.debug("[WebBlackbox] extension metadata not available", error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureAlarm(): Promise<void> {
    if (!deps.alarms) {
      return;
    }

    try {
      const existing = await deps.alarms.get?.(EXTENSION_UPDATE_ALARM);

      if (existing?.periodInMinutes === EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES) {
        return;
      }

      await deps.alarms.create(EXTENSION_UPDATE_ALARM, {
        delayInMinutes: EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES,
        periodInMinutes: EXTENSION_UPDATE_CHECK_INTERVAL_MINUTES
      });
    } catch (error) {
      console.debug("[WebBlackbox] extension update alarm unavailable", error);
    }
  }

  async function badge(): Promise<BadgeSpec | null> {
    const notice = await loadExtensionUpdateNotice(deps.storageLocal, deps.installedVersion);
    return notice ? UPDATE_AVAILABLE_BADGE : null;
  }

  function handleStorageChange(changes: Record<string, unknown>, areaName: string): void {
    if (
      (areaName === "local" && Object.hasOwn(changes, PLAYER_URL_STORAGE_KEY)) ||
      areaName === "managed"
    ) {
      void check();
      return;
    }

    if (
      areaName === "local" &&
      (Object.hasOwn(changes, EXTENSION_UPDATE_STORAGE_KEY) ||
        Object.hasOwn(changes, EXTENSION_UPDATE_DISMISSED_STORAGE_KEY))
    ) {
      void deps.refreshBadge().catch((error: unknown) => {
        console.debug("[WebBlackbox] action badge refresh failed", error);
      });
    }
  }

  return { check, ensureAlarm, badge, handleStorageChange };
}
