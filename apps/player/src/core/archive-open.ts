import { WebBlackboxPlayer, type PlayerOpenOptions } from "@webblackbox/player-sdk";

/** Why a passphrase is requested: the archive is encrypted, or the last one did not decrypt it. */
export type PassphraseRequestReason = "required" | "invalid";

export type PassphraseRequest = {
  fileName: string;
  reason: PassphraseRequestReason;
  attempt: number;
};

/** Returns the passphrase, or `null` when the user cancels. */
export type PassphraseProvider = (request: PassphraseRequest) => Promise<string | null>;

export type ArchiveOpener<TPlayer> = (
  bytes: Uint8Array,
  options?: PlayerOpenOptions
) => Promise<TPlayer>;

export type OpenArchiveOptions<TPlayer> = {
  fileName: string;
  requestPassphrase: PassphraseProvider;
  /** Defaults to `WebBlackboxPlayer.open`; injectable for tests. */
  open?: ArchiveOpener<TPlayer>;
};

export type OpenArchiveErrorCode = "passphrase-cancelled" | "load-failed";

/** Opening failed: the user cancelled the passphrase prompt, or the archive could not be read. */
export class OpenArchiveError extends Error {
  public readonly code: OpenArchiveErrorCode;

  public constructor(code: OpenArchiveErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OpenArchiveError";
    this.code = code;
  }
}

/** The SDK refuses an encrypted archive opened without a passphrase. */
export function isPassphraseRequiredError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("encrypted") && message.includes("passphrase");
}

/** A passphrase was given but did not decrypt the archive (AES-GCM authentication failed). */
export function isInvalidPassphraseError(error: unknown): boolean {
  if (error instanceof Error && error.name === "OperationError") {
    return true;
  }

  const message = String(error).toLowerCase();
  return message.includes("unable to decrypt") || message.includes("passphrase may be invalid");
}

const defaultOpen: ArchiveOpener<WebBlackboxPlayer> = (bytes, options) =>
  WebBlackboxPlayer.open(bytes, options);

/**
 * Opens an archive, asking for a passphrase while it is encrypted. A wrong passphrase asks again
 * (reason `invalid`) until the archive opens or the user cancels; other failures are rethrown as
 * `load-failed`. The passphrase is never stored.
 */
export async function openArchiveWithPassphrase<TPlayer = WebBlackboxPlayer>(
  bytes: Uint8Array,
  options: OpenArchiveOptions<TPlayer>
): Promise<TPlayer> {
  const open = options.open ?? (defaultOpen as unknown as ArchiveOpener<TPlayer>);

  try {
    return await open(bytes);
  } catch (error) {
    if (!isPassphraseRequiredError(error)) {
      throw toLoadFailed(error);
    }
  }

  let reason: PassphraseRequestReason = "required";

  for (let attempt = 1; ; attempt += 1) {
    const passphrase = (
      await options.requestPassphrase({ fileName: options.fileName, reason, attempt })
    )?.trim();

    if (!passphrase) {
      throw new OpenArchiveError("passphrase-cancelled", "Passphrase entry was cancelled.");
    }

    try {
      return await open(bytes, { passphrase });
    } catch (error) {
      if (!isInvalidPassphraseError(error) && !isPassphraseRequiredError(error)) {
        throw toLoadFailed(error);
      }

      reason = "invalid";
    }
  }
}

function toLoadFailed(error: unknown): OpenArchiveError {
  const message = error instanceof Error ? error.message : String(error);
  return new OpenArchiveError("load-failed", message, error);
}
