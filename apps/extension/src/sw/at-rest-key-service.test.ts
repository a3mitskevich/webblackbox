import { describe, expect, it, vi } from "vitest";

import type { PortLike } from "../shared/chrome-api.js";
import { AT_REST_KEY_STORAGE_KEY, type AtRestKeyRecord } from "./at-rest-key.js";
import { createAtRestKeyService } from "./at-rest-key-service.js";

function createStorageArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));

  return {
    data,
    area: {
      get: vi.fn(async (keys: string) =>
        data.has(keys) ? { [keys]: data.get(keys) } : ({} as Record<string, unknown>)
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          data.set(key, value);
        }
      }),
      setAccessLevel: vi.fn(async () => undefined)
    }
  };
}

function createPort(): PortLike {
  return {
    name: "offscreen",
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    postMessage: vi.fn()
  };
}

describe("createAtRestKeyService", () => {
  it("mints and caches the key for the worker's lifetime", async () => {
    const { data, area } = createStorageArea();
    const service = createAtRestKeyService({
      storageArea: area,
      indexedDb: undefined,
      dbName: "test-db",
      post: vi.fn()
    });

    const first = await service.getAtRestKey();
    const second = await service.getAtRestKey();

    expect(first).toBe(second);
    expect(area.set).toHaveBeenCalledTimes(1);
    expect(data.get(AT_REST_KEY_STORAGE_KEY)).toEqual(first);
    expect(service.isAtRestKeyFresh()).toBe(true);
  });

  it("restores a stored key and reports it as not fresh", async () => {
    // A valid base64 encoding of the 32 key bytes.
    const existing: AtRestKeyRecord = {
      keyId: "0123456789abcdef",
      key: Buffer.from(new Uint8Array(32)).toString("base64"),
      createdAt: 1_000
    };

    const { area } = createStorageArea({ [AT_REST_KEY_STORAGE_KEY]: existing });
    const service = createAtRestKeyService({
      storageArea: area,
      indexedDb: undefined,
      dbName: "test-db",
      post: vi.fn()
    });

    await expect(service.getAtRestKey()).resolves.toEqual(existing);
    expect(service.isAtRestKeyFresh()).toBe(false);
    expect(area.set).not.toHaveBeenCalled();
  });

  it("retries the bootstrap after a failure", async () => {
    const { area } = createStorageArea();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    area.get.mockRejectedValueOnce(new Error("storage down"));

    const service = createAtRestKeyService({
      storageArea: area,
      indexedDb: undefined,
      dbName: "test-db",
      post: vi.fn()
    });

    await expect(service.getAtRestKey()).rejects.toThrow("storage down");
    await expect(service.getAtRestKey()).resolves.toMatchObject({ keyId: expect.any(String) });

    warn.mockRestore();
    info.mockRestore();
  });

  it("sends the key to the offscreen document and swallows send failures with a warning", async () => {
    const { area } = createStorageArea();
    const post = vi.fn();
    const service = createAtRestKeyService({
      storageArea: area,
      indexedDb: undefined,
      dbName: "test-db",
      post
    });
    const port = createPort();

    await service.sendAtRestKeyToOffscreen(port);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(port);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ keyId: expect.any(String) });

    post.mockImplementation(() => {
      throw new Error("port closed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(service.sendAtRestKeyToOffscreen(port)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
