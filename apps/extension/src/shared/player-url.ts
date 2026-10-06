import {
  createBoundedManagedPolicyReader,
  readManagedEnterprisePolicy
} from "./options-storage.js";

/**
 * Address of the Player that "Export and open in Player" opens (the organization's self-hosted
 * Player). Only the page is opened: the archive stays in the downloads folder and the user drops
 * it into the Player, so nothing is ever sent to this address. Empty by default, which hides the
 * action. A user preference under its own storage key; the managed policy key `playerUrl`
 * (scoped `enterprisePolicy.playerUrl` or flat) presets it and wins.
 */

export const PLAYER_URL_STORAGE_KEY = "webblackbox.playerUrl";
export const PLAYER_URL_POLICY_KEY = "playerUrl";

/**
 * How long an extension page waits for the managed policy before it goes on without it, as the
 * service worker does on Start (see `createBoundedManagedPolicyReader`).
 */
const MANAGED_POLICY_READ_TIMEOUT_MS = 3_000;

/** Plain http is only accepted for a Player served from this computer. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

type StorageAreaLike = {
  get(keys?: string[] | string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
};

export type PlayerUrlParse = { ok: true; value: string } | { ok: false };

export type PlayerUrlSetting = {
  /** Normalized absolute URL, or "" when no Player is configured. */
  url: string;
  /** Set by the organization's policy (read-only in Options). */
  managed: boolean;
};

/**
 * Validates typed input: trimmed; empty clears the setting; otherwise an absolute `https:` URL,
 * or `http:` on localhost / 127.0.0.1, without credentials. Returns the normalized href.
 */
export function parsePlayerUrl(raw: string): PlayerUrlParse {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return { ok: true, value: "" };
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false };
  }

  const isSecure = url.protocol === "https:";
  const isLoopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

  if ((!isSecure && !isLoopback) || url.hostname === "" || url.username || url.password) {
    return { ok: false };
  }

  return { ok: true, value: url.href };
}

/** A stored or managed value: the normalized URL when valid, otherwise "" (not configured). */
export function normalizePlayerUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const parsed = parsePlayerUrl(value);
  return parsed.ok ? parsed.value : "";
}

/** A configured managed URL wins; an empty or invalid managed value leaves the user's choice. */
export function resolvePlayerUrl(local: unknown, managed: string): PlayerUrlSetting {
  return managed
    ? { url: managed, managed: true }
    : { url: normalizePlayerUrl(local), managed: false };
}

/**
 * The policy's Player URL, or "" when unset, invalid or unavailable (also when the policy has not
 * answered after `MANAGED_POLICY_READ_TIMEOUT_MS`). Never throws.
 */
export async function loadManagedPlayerUrl(managed: StorageAreaLike | undefined): Promise<string> {
  const readPolicy = createBoundedManagedPolicyReader(() => readManagedEnterprisePolicy(managed), {
    timeoutMs: MANAGED_POLICY_READ_TIMEOUT_MS
  });
  const policy = await readPolicy();
  return normalizePlayerUrl(policy?.[PLAYER_URL_POLICY_KEY]);
}

/** The effective setting. Never throws: failing storage reads as "not configured". */
export async function loadPlayerUrlSetting(
  storage: { local?: StorageAreaLike; managed?: StorageAreaLike } | undefined
): Promise<PlayerUrlSetting> {
  const [local, managed] = await Promise.all([
    readLocalPlayerUrl(storage?.local),
    loadManagedPlayerUrl(storage?.managed)
  ]);

  return resolvePlayerUrl(local, managed);
}

async function readLocalPlayerUrl(local: StorageAreaLike | undefined): Promise<unknown> {
  try {
    const values = await local?.get(PLAYER_URL_STORAGE_KEY);
    return values?.[PLAYER_URL_STORAGE_KEY];
  } catch {
    return undefined;
  }
}
