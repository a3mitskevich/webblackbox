import { describe, expect, it, vi } from "vitest";

import {
  isInvalidPassphraseError,
  isPassphraseRequiredError,
  openArchiveWithPassphrase,
  OpenArchiveError,
  type ArchiveOpener,
  type PassphraseRequest
} from "./archive-open.js";

const BYTES = new Uint8Array([1, 2, 3]);
const REQUIRED = new Error("Archive is encrypted. Provide a passphrase to open it.");

function operationError(): Error {
  const error = new Error("The operation failed for an operation-specific reason");
  error.name = "OperationError";
  return error;
}

/** An opener that accepts only `secret`; without a passphrase it reports "encrypted". */
function encryptedOpener(secret: string): ArchiveOpener<string> {
  return async (_bytes, options) => {
    if (!options?.passphrase) {
      throw REQUIRED;
    }

    if (options.passphrase !== secret) {
      throw operationError();
    }

    return "player";
  };
}

describe("error classification", () => {
  it("recognises missing and wrong passphrases", () => {
    expect(isPassphraseRequiredError(REQUIRED)).toBe(true);
    expect(isPassphraseRequiredError(new Error("bad zip"))).toBe(false);
    expect(isInvalidPassphraseError(operationError())).toBe(true);
    expect(
      isInvalidPassphraseError(
        new Error("Unable to decrypt archive content. The passphrase may be invalid.")
      )
    ).toBe(true);
    expect(isInvalidPassphraseError(new Error("bad zip"))).toBe(false);
  });
});

describe("openArchiveWithPassphrase", () => {
  it("opens plain archives without asking", async () => {
    const requestPassphrase = vi.fn();
    const player = await openArchiveWithPassphrase(BYTES, {
      fileName: "plain.webblackbox",
      requestPassphrase,
      open: async () => "plain"
    });

    expect(player).toBe("plain");
    expect(requestPassphrase).not.toHaveBeenCalled();
  });

  it("asks again after a wrong passphrase and trims the answer", async () => {
    const answers = ["wrong", "  secret  "];
    const requests: PassphraseRequest[] = [];
    const player = await openArchiveWithPassphrase(BYTES, {
      fileName: "s.zip",
      open: encryptedOpener("secret"),
      requestPassphrase: async (request) => {
        requests.push(request);
        return answers.shift() ?? null;
      }
    });

    expect(player).toBe("player");
    expect(requests).toEqual([
      { fileName: "s.zip", reason: "required", attempt: 1 },
      { fileName: "s.zip", reason: "invalid", attempt: 2 }
    ]);
  });

  it("reports a cancelled prompt and empty answers as cancellation", async () => {
    for (const answer of [null, "   "]) {
      await expect(
        openArchiveWithPassphrase(BYTES, {
          fileName: "s.zip",
          open: encryptedOpener("secret"),
          requestPassphrase: async () => answer
        })
      ).rejects.toMatchObject({ code: "passphrase-cancelled" });
    }
  });

  it("wraps other failures as load-failed", async () => {
    const broken = openArchiveWithPassphrase(BYTES, {
      fileName: "broken.zip",
      open: async () => {
        throw new Error("End of central directory not found");
      },
      requestPassphrase: async () => null
    });

    await expect(broken).rejects.toBeInstanceOf(OpenArchiveError);
    await expect(broken).rejects.toMatchObject({
      code: "load-failed",
      message: "End of central directory not found"
    });

    let calls = 0;
    const afterPassphrase = openArchiveWithPassphrase(BYTES, {
      fileName: "s.zip",
      open: async (_bytes, options) => {
        calls += 1;

        if (!options?.passphrase) {
          throw REQUIRED;
        }

        throw "integrity mismatch";
      },
      requestPassphrase: async () => "secret"
    });

    await expect(afterPassphrase).rejects.toMatchObject({
      code: "load-failed",
      message: "integrity mismatch"
    });
    expect(calls).toBe(2);
  });
});
