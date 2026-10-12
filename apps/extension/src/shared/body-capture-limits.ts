/**
 * Per-body capture limits shared by every place that reads or edits the setting: the profile
 * model, the options page, the service worker and the content script. Dependency-free, so the
 * page-side bundles can import it.
 */

/** Ceiling of the per-body limit (`sampling.bodyCaptureMaxBytes`, `network.bodyMaxBytes`). */
export const MAX_BODY_CAPTURE_BYTES = 8 * 1024 * 1024;

/** Smallest non-zero per-body limit; lower values are raised to it. */
export const MIN_BODY_CAPTURE_BYTES = 4 * 1024;

/** Default per-body limit of CDP-backed (full) sessions, the same as the Full capture preset. */
export const FULL_MODE_BODY_CAPTURE_MAX_BYTES = 1024 * 1024;

/** Per-body limit clamped to the shared floor and ceiling; zero or less turns bodies off. */
export function clampBodyCaptureMaxBytes(value: number): number {
  if (value <= 0) {
    return 0;
  }

  return Math.max(MIN_BODY_CAPTURE_BYTES, Math.min(MAX_BODY_CAPTURE_BYTES, Math.round(value)));
}
