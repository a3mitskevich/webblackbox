import type { WebBlackboxPlayer } from "@webblackbox/player-sdk";

import {
  openArchiveWithPassphrase,
  OpenArchiveError,
  type ArchiveOpener
} from "../../../core/archive-open.js";
import type { ArchiveSource } from "../../controller.js";
import type { PlayerState } from "../../state.js";
import type { Store } from "../../store.js";
import { compareSlice, type CompareSlice } from "./slice.js";

const ARCHIVE_NAME_PATTERN = /\.(webblackbox|zip)$/i;

type PendingPassphrase = (value: string | null) => void;

type SessionState = { token: number; pending: PendingPassphrase | null };

const sessions = new WeakMap<Store<PlayerState>, SessionState>();

function sessionOf(store: Store<PlayerState>): SessionState {
  const existing = sessions.get(store);

  if (existing) {
    return existing;
  }

  const created: SessionState = { token: 0, pending: null };
  sessions.set(store, created);
  return created;
}

function patch(store: Store<PlayerState>, next: Partial<CompareSlice>): void {
  compareSlice.update(store, (slice) => ({ ...slice, ...next }));
}

export type CompareOpenOptions = {
  open?: ArchiveOpener<WebBlackboxPlayer>;
  /** "Not a .webblackbox / .zip file" in the current locale. */
  unsupportedMessage: string;
};

/**
 * Opens session B for Compare. Encrypted archives ask for their passphrase in the Compare panel's
 * own dialog (never stored); a newer file cancels an older one still waiting for its passphrase.
 */
export async function openCompareArchive(
  store: Store<PlayerState>,
  source: ArchiveSource,
  options: CompareOpenOptions
): Promise<void> {
  const session = sessionOf(store);
  const fileName = source.name;
  const token = ++session.token;
  session.pending?.(null);
  session.pending = null;

  if (!ARCHIVE_NAME_PATTERN.test(fileName)) {
    patch(store, { status: { phase: "error", fileName, message: options.unsupportedMessage } });
    return;
  }

  patch(store, { status: { phase: "loading", fileName } });

  try {
    const bytes = new Uint8Array(await source.arrayBuffer());
    const player = await openArchiveWithPassphrase(bytes, {
      fileName,
      open: options.open,
      requestPassphrase: (request) =>
        new Promise<string | null>((resolve) => {
          if (token !== session.token) {
            resolve(null);
            return;
          }

          session.pending = resolve;
          patch(store, {
            status: { phase: "passphrase", fileName, invalid: request.reason === "invalid" }
          });
        })
    });

    if (token === session.token) {
      patch(store, { status: { phase: "ready" }, other: { fileName, player }, selectedKey: null });
    }
  } catch (error) {
    if (token !== session.token) {
      return;
    }

    const previous = compareSlice.select(store.getState()).other;

    if (error instanceof OpenArchiveError && error.code === "passphrase-cancelled") {
      patch(store, { status: previous ? { phase: "ready" } : { phase: "empty" } });
      return;
    }

    patch(store, {
      status: {
        phase: "error",
        fileName,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  } finally {
    if (token === session.token) {
      session.pending = null;
    }
  }
}

export function submitComparePassphrase(store: Store<PlayerState>, passphrase: string): void {
  const session = sessionOf(store);
  const resolve = session.pending;
  session.pending = null;
  const { status } = compareSlice.select(store.getState());

  if (status.phase === "passphrase") {
    patch(store, { status: { phase: "loading", fileName: status.fileName } });
  }

  resolve?.(passphrase);
}

export function cancelComparePassphrase(store: Store<PlayerState>): void {
  const session = sessionOf(store);
  const resolve = session.pending;
  session.pending = null;
  resolve?.(null);
}

/** Drops session B (and any load still running). */
export function clearCompare(store: Store<PlayerState>): void {
  const session = sessionOf(store);
  session.token += 1;
  session.pending?.(null);
  session.pending = null;
  patch(store, { status: { phase: "empty" }, other: null, selectedKey: null });
}

export function dismissCompareError(store: Store<PlayerState>): void {
  const { other } = compareSlice.select(store.getState());
  patch(store, { status: other ? { phase: "ready" } : { phase: "empty" } });
}
