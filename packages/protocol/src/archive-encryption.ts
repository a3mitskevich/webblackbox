/**
 * Every exported archive is encrypted: masking captured content is best effort, the passphrase
 * and encryption are what protect a recording.
 */

/** Archives written since mandatory encryption: a plaintext envelope plus an encrypted manifest. */
export const ARCHIVE_FORMAT_VERSION = 2;

/** Path of the encrypted full manifest in a format-2 archive. */
export const ENCRYPTED_MANIFEST_PATH = "meta/manifest.json";

/** Shortest export passphrase accepted (after trimming). */
export const MIN_EXPORT_PASSPHRASE_LENGTH = 8;

/** The passphrase as used for encryption: surrounding whitespace is not part of it. */
export function normalizeExportPassphrase(passphrase: string | null | undefined): string {
  return typeof passphrase === "string" ? passphrase.trim() : "";
}

/** Whether `passphrase` may encrypt an export. */
export function isValidExportPassphrase(passphrase: string | null | undefined): boolean {
  return normalizeExportPassphrase(passphrase).length >= MIN_EXPORT_PASSPHRASE_LENGTH;
}

/** Throws unless `passphrase` may encrypt an export: there is no plaintext export. */
export function assertExportPassphrase(passphrase: string | null | undefined): void {
  if (!isValidExportPassphrase(passphrase)) {
    throw new Error(
      `Archives are always encrypted: enter a passphrase of at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`
    );
  }
}
