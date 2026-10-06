import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_START_RELOAD_OFFER,
  loadStartReloadOffer,
  normalizeStartReloadOffer,
  START_RELOAD_OFFER_STORAGE_KEY
} from "./start-reload-offer.js";

function storageArea(get: () => Promise<Record<string, unknown>>) {
  return { get: vi.fn(get), set: vi.fn(async () => undefined) };
}

describe("start reload offer setting", () => {
  it("is on by default", () => {
    expect(DEFAULT_START_RELOAD_OFFER).toBe(true);
  });

  it.each([
    [true, true],
    [false, false],
    [undefined, true],
    [null, true],
    ["false", true],
    [0, true]
  ])("reads stored %j as %j", (stored, expected) => {
    expect(normalizeStartReloadOffer(stored)).toBe(expected);
  });

  it("loads the stored flag from its own key", async () => {
    const area = storageArea(async () => ({ [START_RELOAD_OFFER_STORAGE_KEY]: false }));

    await expect(loadStartReloadOffer(area)).resolves.toBe(false);
    expect(area.get).toHaveBeenCalledWith(START_RELOAD_OFFER_STORAGE_KEY);
  });

  it("offers the reload on installs that never stored the flag", async () => {
    await expect(loadStartReloadOffer(storageArea(async () => ({})))).resolves.toBe(true);
  });

  it("falls back to the default without storage or when reading fails", async () => {
    await expect(loadStartReloadOffer(undefined)).resolves.toBe(true);
    await expect(
      loadStartReloadOffer(
        storageArea(async () => {
          throw new Error("storage unavailable");
        })
      )
    ).resolves.toBe(true);
  });
});
