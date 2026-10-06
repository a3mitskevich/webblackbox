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

/** Decrypted bodies kept per archive; the least recently opened go first beyond this. */
export const BLOB_CACHE_BYTES = 64 * 1024 * 1024;

type BlobCacheEntry = { pending: Promise<BlobValue>; bytes: number };
export type BlobCache = { entries: Map<string, BlobCacheEntry>; bytes: number };

/** Blobs read once per archive (bodies are immutable; reading decrypts and checks integrity). */
const blobCaches = new WeakMap<WebBlackboxPlayer, BlobCache>();

function readBlob(player: WebBlackboxPlayer, hash: string): Promise<BlobValue> {
  let cache = blobCaches.get(player);

  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    blobCaches.set(player, cache);
  }

  return readCachedBlob(cache, hash, () => player.getBlob(hash));
}

/** LRU over blob reads: a hit moves to the back, a resolved read may evict from the front. */
export function readCachedBlob(
  cache: BlobCache,
  hash: string,
  read: () => Promise<BlobValue>,
  budget = BLOB_CACHE_BYTES
): Promise<BlobValue> {
  const cached = cache.entries.get(hash);

  if (cached) {
    cache.entries.delete(hash);
    cache.entries.set(hash, cached);
    return cached.pending;
  }

  const entry: BlobCacheEntry = { pending: read(), bytes: 0 };
  cache.entries.set(hash, entry);
  entry.pending.then(
    (value) => {
      if (cache.entries.get(hash) !== entry) {
        return;
      }

      entry.bytes = value?.bytes.byteLength ?? 0;
      cache.bytes += entry.bytes;
      evictBlobs(cache, hash, budget);
    },
    // A failed read is not cached: opening the request again retries it.
    () => {
      if (cache.entries.get(hash) === entry) {
        cache.entries.delete(hash);
      }
    }
  );
  return entry.pending;
}

function evictBlobs(cache: BlobCache, keep: string, budget: number): void {
  for (const [hash, entry] of cache.entries) {
    if (cache.bytes <= budget) {
      return;
    }

    if (hash !== keep) {
      cache.entries.delete(hash);
      cache.bytes -= entry.bytes;
    }
  }
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
