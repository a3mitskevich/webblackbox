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
  it("asks by default", () => {
    expect(DEFAULT_START_RELOAD_OFFER).toBe("ask");
  });

  it.each([
    ["ask", "ask"],
    ["always", "always"],
    ["never", "never"],
    // Earlier versions stored a switch: on asked, off started without a reload.
    [true, "ask"],
    [false, "never"],
    [undefined, "ask"],
    [null, "ask"],
    ["false", "ask"],
    [0, "ask"]
  ])("reads stored %j as %j", (stored, expected) => {
    expect(normalizeStartReloadOffer(stored)).toBe(expected);
  });

  it("loads the stored choice from its own key", async () => {
    const area = storageArea(async () => ({ [START_RELOAD_OFFER_STORAGE_KEY]: "always" }));

    await expect(loadStartReloadOffer(area)).resolves.toBe("always");
    expect(area.get).toHaveBeenCalledWith(START_RELOAD_OFFER_STORAGE_KEY);
  });

  it("asks on installs that never stored a choice", async () => {
    await expect(loadStartReloadOffer(storageArea(async () => ({})))).resolves.toBe("ask");
  });

  it("falls back to the default without storage or when reading fails", async () => {
    await expect(loadStartReloadOffer(undefined)).resolves.toBe("ask");
    await expect(
      loadStartReloadOffer(
        storageArea(async () => {
          throw new Error("storage unavailable");
        })
      )
    ).resolves.toBe("ask");
  });
});
