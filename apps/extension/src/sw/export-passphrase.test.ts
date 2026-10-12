import { describe, expect, it, vi } from "vitest";

import { createExportPassphraseStore, EXPORT_PASSPHRASE_STORAGE_KEY } from "./export-passphrase.js";

function createSessionArea(initial: Record<string, unknown> = {}) {
  let stored: Record<string, unknown> = { ...initial };

  return {
    get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      stored = { ...stored, ...items };
    }),
    remove: vi.fn(async (key: string) => {
      stored = Object.fromEntries(Object.entries(stored).filter(([name]) => name !== key));
    }),
    stored: () => stored
  };
}

describe("export passphrase store", () => {
  it("keeps the passphrase in the session area only, and forgets it", async () => {
    const area = createSessionArea();
    const store = createExportPassphraseStore(area);

    await expect(store.get()).resolves.toBeUndefined();
    await store.remember("correct horse battery");

    await expect(store.get()).resolves.toBe("correct horse battery");
    expect(area.stored()).toEqual({ [EXPORT_PASSPHRASE_STORAGE_KEY]: "correct horse battery" });

    await store.forget();

    await expect(store.get()).resolves.toBeUndefined();
    expect(area.stored()).toEqual({});
  });

  it("reads what an earlier worker of the browser session remembered, once", async () => {
    const area = createSessionArea({ [EXPORT_PASSPHRASE_STORAGE_KEY]: "kept-by-earlier-worker" });
    const store = createExportPassphraseStore(area);

    await expect(store.get()).resolves.toBe("kept-by-earlier-worker");
    await expect(store.get()).resolves.toBe("kept-by-earlier-worker");
    expect(area.get).toHaveBeenCalledTimes(1);
  });

  it("still remembers in memory when the area fails or is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = createSessionArea();
    failing.set.mockRejectedValue(new Error("quota"));
    const store = createExportPassphraseStore(failing);
    const memoryOnly = createExportPassphraseStore(undefined);

    await store.remember("correct horse battery");
    await memoryOnly.remember("another long passphrase");

    await expect(store.get()).resolves.toBe("correct horse battery");
    await expect(memoryOnly.get()).resolves.toBe("another long passphrase");
  });
});
