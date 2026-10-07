/**
 * The bundled-extension metadata the player build writes next to the zip
 * (`extension/extension.json`, see scripts/lib/bundle-extension.mjs); the guide reads it
 * same-origin. Fetched JSON is untrusted input: validated field by field before use.
 */
export type ExtensionBundleMetadata = {
  version: string;
  file: string;
  size: number;
  sha256: string;
  /** ISO 8601 UTC. */
  builtAt: string;
};

export type ExtensionBundleState =
  | { phase: "loading" }
  | { phase: "bundled"; metadata: ExtensionBundleMetadata }
  | { phase: "missing" };

/** The in-build zip name is fixed by the build script, so the download URL never changes. */
export const EXTENSION_ZIP_FILE = "webblackbox-chrome.zip";
export const EXTENSION_METADATA_URL = "extension/extension.json";
export const EXTENSION_ZIP_URL = `extension/${EXTENSION_ZIP_FILE}`;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function parseExtensionBundleMetadata(value: unknown): ExtensionBundleMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;

  if (
    typeof row.version !== "string" ||
    row.version.length === 0 ||
    row.file !== EXTENSION_ZIP_FILE ||
    typeof row.size !== "number" ||
    !Number.isFinite(row.size) ||
    row.size <= 0 ||
    typeof row.sha256 !== "string" ||
    !SHA256_PATTERN.test(row.sha256) ||
    typeof row.builtAt !== "string" ||
    Number.isNaN(Date.parse(row.builtAt))
  ) {
    return null;
  }

  return {
    version: row.version,
    file: row.file,
    size: row.size,
    sha256: row.sha256,
    builtAt: row.builtAt
  };
}

/**
 * Reads `extension/extension.json` relative to the Player's own URL (same origin, sub-path safe).
 * Any failure — no file, bad JSON, a shape mismatch — means "not bundled", not an error.
 */
export async function fetchExtensionBundleMetadata(
  fetchImpl: typeof fetch = fetch
): Promise<ExtensionBundleMetadata | null> {
  let response: Response;

  try {
    response = await fetchImpl(EXTENSION_METADATA_URL);
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  try {
    return parseExtensionBundleMetadata(await response.json());
  } catch {
    return null;
  }
}
