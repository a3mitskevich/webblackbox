import { ARCHIVE_KDF_MAX_ITERATIONS, ARCHIVE_KDF_MIN_ITERATIONS } from "./constants.js";

/**
 * Rejects PBKDF2 iteration counts outside the accepted range before a key is derived.
 * The count comes from an untrusted archive manifest, so an unbounded value would let an
 * archive pin the CPU (huge count) or weaken the key (tiny count).
 */
export function assertArchiveKdfIterations(iterations: unknown): asserts iterations is number {
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < ARCHIVE_KDF_MIN_ITERATIONS ||
    iterations > ARCHIVE_KDF_MAX_ITERATIONS
  ) {
    throw new Error(
      `Archive KDF iteration count ${String(iterations)} is outside the supported range ` +
        `${ARCHIVE_KDF_MIN_ITERATIONS}-${ARCHIVE_KDF_MAX_ITERATIONS}.`
    );
  }
}
