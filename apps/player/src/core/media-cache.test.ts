import { describe, expect, it, vi } from "vitest";

import { createMediaUrlCache } from "./media-cache.js";

function setup(ttlMs = 1_000) {
  let time = 0;
  let counter = 0;
  const revoked: string[] = [];
  const cache = createMediaUrlCache({
    ttlMs,
    now: () => time,
    createUrl: () => {
      counter += 1;
      return `blob:${counter}`;
    },
    revokeUrl: (url) => revoked.push(url)
  });
  const media = { parts: [new Uint8Array([1])], mime: "image/png" };
  return { cache, revoked, media, advance: (ms: number) => (time += ms) };
}

describe("createMediaUrlCache", () => {
  it("loads once, shares concurrent loads and reuses the URL", async () => {
    const { cache, media } = setup();
    const load = vi.fn(async () => media);

    const [first, second] = await Promise.all([cache.get("a", load), cache.get("a", load)]);
    const third = await cache.get("a", load);

    expect([first, second, third]).toEqual(["blob:1", "blob:1", "blob:1"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);
  });

  it("revokes expired URLs and returns null for missing media", async () => {
    const { cache, media, revoked, advance } = setup(1_000);

    await cache.get("a", async () => media);
    advance(1_500);
    expect(await cache.get("b", async () => null)).toBeNull();
    expect(await cache.get("c", async () => ({ parts: [], mime: "x" }))).toBeNull();
    expect(revoked).toEqual(["blob:1"]);
    expect(await cache.get("a", async () => media)).toBe("blob:2");
  });

  it("revokes everything on clear, including loads that finish afterwards", async () => {
    const { cache, media, revoked } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await cache.get("a", async () => media);
    const late = cache.get("b", async () => {
      await gate;
      return media;
    });

    cache.clear();
    release();

    expect(await late).toBeNull();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
    expect(cache.size()).toBe(0);
  });

  it("forgets failed loads so they can be retried", async () => {
    const { cache, media } = setup();

    await expect(
      cache.get("a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await cache.get("a", async () => media)).toBe("blob:1");
  });
});
