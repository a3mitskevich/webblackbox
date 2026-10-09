/**
 * "A newer extension version is available" notice. The extension is installed unpacked and is
 * updated by hand from the Player's guide, so this only tells the user: the service worker reads
 * the Player's `extension/extension.json` (written next to the bundled zip by the Player build),
 * keeps the version it found, and the action badge and the popup banner show it until the user
 * updates or dismisses that version. Nothing is downloaded or installed.
 */

/** Written by the service worker after each successful check. */
export const EXTENSION_UPDATE_STORAGE_KEY = "webblackbox.extensionUpdate";
/** Written by the popup: the latest version the user dismissed (its notice stays hidden). */
export const EXTENSION_UPDATE_DISMISSED_STORAGE_KEY = "webblackbox.extensionUpdateDismissed";

/** Where the Player build puts the metadata, relative to the Player's base URL. */
const EXTENSION_METADATA_PATH = "extension/extension.json";

/** Chrome's `version` format: one to four dot-separated integers, 0–65535, no leading zeros. */
const CHROME_VERSION_PATTERN = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/u;
const MAX_VERSION_PART = 65_535;

export type ExtensionUpdateState = {
  /** The newest version the Player offers. */
  latestVersion: string;
  /** Epoch ms of the check that found it. */
  checkedAt: number;
  /** The Player that offered it; the popup links there. */
  playerUrl: string;
};

type StorageAreaLike = {
  get(keys?: string[] | string | Record<string, unknown> | null): Promise<Record<string, unknown>>;
};

/** The numeric parts of a Chrome version string, or null when it is not one. */
export function parseChromeVersion(value: unknown): number[] | null {
  if (typeof value !== "string" || !CHROME_VERSION_PATTERN.test(value)) {
    return null;
  }

  const parts = value.split(".").map(Number);
  return parts.every((part) => part <= MAX_VERSION_PART) ? parts : null;
}

/**
 * Compares two Chrome versions part by part (missing parts count as 0, so "1.2" equals "1.2.0").
 * Negative when `left` is older, positive when newer, 0 when equal. Callers validate first.
 */
export function compareChromeVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/** True when `candidate` is a valid version newer than the valid `installed` one. */
export function isNewerVersion(candidate: unknown, installed: unknown): boolean {
  const candidateParts = parseChromeVersion(candidate);
  const installedParts = parseChromeVersion(installed);

  return (
    candidateParts !== null &&
    installedParts !== null &&
    compareChromeVersions(candidateParts, installedParts) > 0
  );
}

/**
 * The metadata URL of a Player. The Player resolves `extension/extension.json` against its own
 * page, so the last path segment counts as a directory unless it names a file (has a dot):
 * `https://host/qa` and `https://host/qa/` both give `https://host/qa/extension/extension.json`,
 * `https://host/qa/index.html` gives the same. Query and fragment are dropped. Null for an
 * unparsable URL.
 */
export function resolveExtensionMetadataUrl(playerUrl: string): string | null {
  let base: URL;

  try {
    base = new URL(playerUrl);
  } catch {
    return null;
  }

  base.search = "";
  base.hash = "";
  const lastSegment = base.pathname.slice(base.pathname.lastIndexOf("/") + 1);

  if (lastSegment !== "" && !lastSegment.includes(".")) {
    base.pathname = `${base.pathname}/`;
  }

  return new URL(EXTENSION_METADATA_PATH, base).href;
}

/**
 * The version from a fetched `extension.json`, or null. The body is untrusted: only an object
 * whose `version` is a valid Chrome version is accepted; other fields are not used.
 */
export function parseExtensionMetadataVersion(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const version = (value as Record<string, unknown>).version;
  return parseChromeVersion(version) ? (version as string) : null;
}

/** A stored update state, or null when absent or malformed. */
export function normalizeExtensionUpdateState(value: unknown): ExtensionUpdateState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;

  if (
    !parseChromeVersion(row.latestVersion) ||
    typeof row.checkedAt !== "number" ||
    !Number.isFinite(row.checkedAt) ||
    typeof row.playerUrl !== "string"
  ) {
    return null;
  }

  return {
    latestVersion: row.latestVersion as string,
    checkedAt: row.checkedAt,
    playerUrl: row.playerUrl
  };
}

export type ExtensionUpdateNotice = {
  latestVersion: string;
  installedVersion: string;
  playerUrl: string;
};

/**
 * The notice to show: a newer version is known and the user has not dismissed that version.
 * Updating the extension makes the versions match, which ends the notice by itself.
 */
export function resolveExtensionUpdateNotice(
  state: ExtensionUpdateState | null,
  dismissedVersion: unknown,
  installedVersion: string
): ExtensionUpdateNotice | null {
  if (
    !state ||
    state.latestVersion === dismissedVersion ||
    !isNewerVersion(state.latestVersion, installedVersion)
  ) {
    return null;
  }

  return { latestVersion: state.latestVersion, installedVersion, playerUrl: state.playerUrl };
}

/** Reads both keys and resolves the notice. Never throws: a failing read means no notice. */
export async function loadExtensionUpdateNotice(
  storage: StorageAreaLike | undefined,
  installedVersion: string
): Promise<ExtensionUpdateNotice | null> {
  try {
    const values = await storage?.get([
      EXTENSION_UPDATE_STORAGE_KEY,
      EXTENSION_UPDATE_DISMISSED_STORAGE_KEY
    ]);
    return resolveExtensionUpdateNotice(
      normalizeExtensionUpdateState(values?.[EXTENSION_UPDATE_STORAGE_KEY]),
      values?.[EXTENSION_UPDATE_DISMISSED_STORAGE_KEY],
      installedVersion
    );
  } catch {
    return null;
  }
}
