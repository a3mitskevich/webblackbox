/** Object URLs of stage media (screenshots, recordings) live this long after their last use. */
export const MEDIA_URL_TTL_MS = 5 * 60 * 1_000;

export type MediaUrlCacheOptions = {
  ttlMs?: number;
  now?: () => number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
};

/** Loads media bytes for a key; `null` when the archive has no such blob. */
export type MediaLoader = () => Promise<{ parts: BlobPart[]; mime: string } | null>;

export type MediaUrlCache = {
  /** The object URL for `key`, loading it once; concurrent calls share one load. */
  get(key: string, load: MediaLoader): Promise<string | null>;
  /** Revokes every URL (call when the archive is replaced or the player unmounts). */
  clear(): void;
  size(): number;
};

/**
 * Object-URL cache for blobs read from the archive. Expired entries are revoked on access; a load
 * that finishes after `clear()` revokes its own URL instead of leaking it.
 */
export function createMediaUrlCache(options: MediaUrlCacheOptions = {}): MediaUrlCache {
  const ttlMs = options.ttlMs ?? MEDIA_URL_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const createUrl = options.createUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = options.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const entries = new Map<string, { url: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string | null>>();
  let generation = 0;

  const prune = (): void => {
    const time = now();

    for (const [key, entry] of entries) {
      if (entry.expiresAt <= time) {
        revokeUrl(entry.url);
        entries.delete(key);
      }
    }
  };

  return {
    async get(key: string, load: MediaLoader): Promise<string | null> {
      prune();
      const cached = entries.get(key);

      if (cached) {
        entries.set(key, { url: cached.url, expiresAt: now() + ttlMs });
        return cached.url;
      }

      const inFlight = pending.get(key);

      if (inFlight) {
        return inFlight;
      }

      const loadGeneration = generation;
      const promise = (async () => {
        try {
          const media = await load();

          if (!media || media.parts.length === 0) {
            return null;
          }

          const url = createUrl(new Blob(media.parts, { type: media.mime }));

          if (loadGeneration !== generation) {
            revokeUrl(url);
            return null;
          }

          entries.set(key, { url, expiresAt: now() + ttlMs });
          return url;
        } finally {
          pending.delete(key);
        }
      })();

      pending.set(key, promise);
      return promise;
    },
    clear(): void {
      generation += 1;

      for (const entry of entries.values()) {
        revokeUrl(entry.url);
      }

      entries.clear();
      pending.clear();
    },
    size(): number {
      return entries.size;
    }
  };
}
