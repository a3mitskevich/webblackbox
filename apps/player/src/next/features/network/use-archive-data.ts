import { useEffect, useRef, useState } from "react";

import type { RealtimeNetworkEntry, WebBlackboxPlayer } from "@webblackbox/player-sdk";

import { usePlayerState } from "../../context.js";

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

export type BlobValue = { mime: string; bytes: Uint8Array } | null;

const playerIds = new WeakMap<WebBlackboxPlayer, number>();
let nextPlayerId = 0;

/** Ids repeat across archives (`E-00000003`), so load keys carry the archive's identity. */
function playerKey(player: WebBlackboxPlayer | null): string {
  if (!player) {
    return "none";
  }

  let id = playerIds.get(player);

  if (id === undefined) {
    nextPlayerId += 1;
    id = nextPlayerId;
    playerIds.set(player, id);
  }

  return String(id);
}

/** Blobs read once per archive (bodies are immutable; reading decrypts and checks integrity). */
const blobCache = new WeakMap<WebBlackboxPlayer, Map<string, Promise<BlobValue>>>();

function readBlob(player: WebBlackboxPlayer, hash: string): Promise<BlobValue> {
  let byHash = blobCache.get(player);

  if (!byHash) {
    byHash = new Map();
    blobCache.set(player, byHash);
  }

  const cached = byHash.get(hash);

  if (cached) {
    return cached;
  }

  const pending = player.getBlob(hash);
  const cache = byHash;
  // A failed read is not cached: opening the request again retries it.
  pending.catch(() => cache.delete(hash));
  cache.set(hash, pending);
  return pending;
}

/**
 * Runs `load` whenever `key` changes and keeps only the latest answer; `null` (nothing to load)
 * gives `null`.
 */
function useLoadable<T>(load: (() => Promise<T>) | null, key: string): Loadable<T> | null {
  const [state, setState] = useState<{ key: string; value: Loadable<T> } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = load !== null;

  useEffect(() => {
    const run = loadRef.current;

    if (!run) {
      return;
    }

    let cancelled = false;
    run()
      .then((value) => {
        if (!cancelled) {
          setState({ key, value: { status: "ready", value } });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setState({ key, value: { status: "error", message } });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, enabled]);

  if (!enabled) {
    return null;
  }

  return state?.key === key ? state.value : { status: "loading" };
}

/** A body blob of the open archive by content hash; `null` without a hash. */
export function useBlob(hash: string | undefined): Loadable<BlobValue> | null {
  const player = usePlayerState((state) => state.archive?.player ?? null);
  return useLoadable(
    player && hash ? () => readBlob(player, hash) : null,
    `${playerKey(player)}:${hash ?? ""}`
  );
}

/**
 * The whole payload of a realtime message: the inline preview, or the blob a large frame was
 * stored in (`payloadHash`, read through player-sdk).
 */
export function useRealtimeText(
  entry: RealtimeNetworkEntry | null
): Loadable<string | null> | null {
  const player = usePlayerState((state) => state.archive?.player ?? null);

  return useLoadable(
    player && entry
      ? () =>
          entry.payloadHash
            ? player.getRealtimePayloadText(entry.eventId)
            : Promise.resolve(entry.payloadPreview ?? null)
      : null,
    `${playerKey(player)}:${entry?.eventId ?? ""}`
  );
}
