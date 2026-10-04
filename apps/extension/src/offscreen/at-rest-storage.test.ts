import {
  EncryptedPipelineStorage,
  generatePipelineStorageKeyBytes,
  importPipelineStorageKey,
  MemoryPipelineStorage
} from "@webblackbox/pipeline";
import type { SessionMetadata } from "@webblackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  bytesToBase64,
  STORAGE_KEY_MESSAGE_KIND,
  type StorageKeyMessage
} from "../shared/at-rest.js";
import { createAtRestStorageProvider } from "./at-rest-storage.js";

const SESSION: SessionMetadata = {
  sid: "S-offscreen",
  tabId: 3,
  startedAt: 1_700_000_000_000,
  mode: "full",
  url: "https://app.example.test/?token=PLANTED-OFFSCREEN",
  title: "PLANTED-OFFSCREEN-TITLE",
  tags: []
};

function createKeyMessage(
  keyId: string,
  raw = generatePipelineStorageKeyBytes()
): StorageKeyMessage {
  return { kind: STORAGE_KEY_MESSAGE_KIND, keyId, key: bytesToBase64(raw) };
}

describe("offscreen at-rest storage provider", () => {
  it("encrypts with the key from the service worker and zeroes the raw bytes", async () => {
    const inner = new MemoryPipelineStorage();
    const importedRaw: Uint8Array[] = [];
    const provider = createAtRestStorageProvider({
      createInnerStorage: () => inner,
      importKey: async (raw) => {
        importedRaw.push(raw);
        return importPipelineStorageKey(raw);
      }
    });

    await provider.acceptKey(createKeyMessage("0123456789abcdef"));
    const storage = await provider.getStorage();
    await storage.putSession(SESSION);

    expect(importedRaw).toHaveLength(1);
    expect(Array.from(importedRaw[0] ?? [])).toEqual(new Array(32).fill(0));
    expect(await storage.getSession(SESSION.sid)).toEqual(SESSION);
    expect(JSON.stringify(await inner.getSession(SESSION.sid))).not.toContain("PLANTED");
  });

  it("purges unreadable sessions even without a purge callback", async () => {
    const inner = new MemoryPipelineStorage();
    await inner.putSession({ ...SESSION, sid: "S-plaintext" });

    const provider = createAtRestStorageProvider({ createInnerStorage: () => inner });
    await provider.acceptKey(createKeyMessage("5555555555555555"));

    expect(await inner.listSessions()).toEqual([]);
  });

  it("purges sessions written under a previous browser session's key", async () => {
    const inner = new MemoryPipelineStorage();
    const previous = new EncryptedPipelineStorage(inner, {
      key: await importPipelineStorageKey(generatePipelineStorageKeyBytes())
    });
    const onPurged = vi.fn();

    await previous.putSession(SESSION);
    await inner.putSession({ ...SESSION, sid: "S-plaintext" });

    const provider = createAtRestStorageProvider({ createInnerStorage: () => inner, onPurged });
    await provider.acceptKey(createKeyMessage("fedcba9876543210"));

    expect(onPurged).toHaveBeenCalledWith({
      deleted: ["S-offscreen", "S-plaintext"],
      failed: []
    });
    expect(await inner.listSessions()).toEqual([]);
  });

  it("reuses the storage for a repeated key and switches on a new one", async () => {
    const createInnerStorage = vi.fn(() => new MemoryPipelineStorage());
    const provider = createAtRestStorageProvider({ createInnerStorage });
    const message = createKeyMessage("1111111111111111");

    await provider.acceptKey(message);
    const first = await provider.getStorage();
    await provider.acceptKey(message);

    expect(await provider.getStorage()).toBe(first);
    expect(createInnerStorage).toHaveBeenCalledTimes(1);

    await provider.acceptKey(createKeyMessage("2222222222222222"));
    expect(await provider.getStorage()).not.toBe(first);
  });

  it("waits for the key, and fails clearly when it never arrives", async () => {
    const provider = createAtRestStorageProvider({
      createInnerStorage: () => new MemoryPipelineStorage(),
      keyTimeoutMs: 1_000
    });
    const pending = provider.getStorage();

    await provider.acceptKey(createKeyMessage("3333333333333333"));
    await expect(pending).resolves.toBeDefined();

    const keyless = createAtRestStorageProvider({ keyTimeoutMs: 10 });
    await expect(keyless.getStorage()).rejects.toThrow(/key was not received/);
  });

  it("still serves storage when the purge fails", async () => {
    const inner = new MemoryPipelineStorage();
    const purgeErrors: unknown[] = [];
    inner.listSessions = async () => {
      throw new Error("idb broke");
    };
    const provider = createAtRestStorageProvider({
      createInnerStorage: () => inner,
      onPurgeError: (error) => purgeErrors.push(error)
    });

    await provider.acceptKey(createKeyMessage("4444444444444444"));

    expect(purgeErrors.map(String)).toEqual(["Error: idb broke"]);
    await expect(provider.getStorage()).resolves.toBeDefined();
  });
});
