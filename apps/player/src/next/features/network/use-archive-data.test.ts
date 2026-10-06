import { describe, expect, it, vi } from "vitest";

import { readCachedBlob, type BlobCache, type BlobValue } from "./use-archive-data.js";

const blob = (size: number): BlobValue => ({ mime: "x", bytes: new Uint8Array(size) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("readCachedBlob", () => {
  it("reads a blob once and serves the cached promise afterwards", async () => {
    const cache: BlobCache = { entries: new Map(), bytes: 0 };
    const read = vi.fn(async () => blob(4));

    await readCachedBlob(cache, "a", read);
    await readCachedBlob(cache, "a", read);

    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.bytes).toBe(4);
  });

  it("evicts the least recently used blobs beyond the byte budget", async () => {
    const cache: BlobCache = { entries: new Map(), bytes: 0 };
    const read = (size: number) => vi.fn(async () => blob(size));

    await readCachedBlob(cache, "a", read(6), 10);
    await readCachedBlob(cache, "b", read(3), 10);
    await readCachedBlob(cache, "a", read(6), 10); // "a" is now the most recent
    await readCachedBlob(cache, "c", read(4), 10);
    await flush();

    expect([...cache.entries.keys()]).toEqual(["a", "c"]);
    expect(cache.bytes).toBe(10);
  });

  it("keeps a blob larger than the budget until the next read", async () => {
    const cache: BlobCache = { entries: new Map(), bytes: 0 };

    await readCachedBlob(cache, "big", async () => blob(20), 10);
    await flush();

    expect([...cache.entries.keys()]).toEqual(["big"]);
  });

  it("does not cache a failed read", async () => {
    const cache: BlobCache = { entries: new Map(), bytes: 0 };

    await expect(
      readCachedBlob(cache, "a", async () => Promise.reject(new Error("integrity")))
    ).rejects.toThrow("integrity");
    await flush();

    expect(cache.entries.size).toBe(0);
  });
});
