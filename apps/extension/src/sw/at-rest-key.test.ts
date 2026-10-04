import { describe, expect, it, vi } from "vitest";

import {
  base64ToBytes,
  parseStorageKeyMessage,
  STORAGE_KEY_MESSAGE_KIND
} from "../shared/at-rest.js";
import {
  AT_REST_KEY_STORAGE_KEY,
  createAtRestKeyRecord,
  deletePipelineDatabase,
  isOffscreenDocumentPort,
  loadOrCreateAtRestKey,
  parseAtRestKeyRecord,
  restrictSessionStorageAccess,
  toStorageKeyMessage,
  type SessionStorageAreaLike
} from "./at-rest-key.js";

const OFFSCREEN_URL = "chrome-extension://abcdefghijklmnop/offscreen.html";

function createSessionArea(initial: Record<string, unknown> = {}): SessionStorageAreaLike & {
  values: Record<string, unknown>;
} {
  const values = { ...initial };

  return {
    values,
    get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    }),
    setAccessLevel: vi.fn(async () => undefined)
  };
}

describe("at-rest key", () => {
  it("mints a 256-bit key once per browser session and reuses it afterwards", async () => {
    const area = createSessionArea();

    const first = await loadOrCreateAtRestKey(area, { now: () => 42 });
    const second = await loadOrCreateAtRestKey(area);

    expect(first.fresh).toBe(true);
    expect(first.record.createdAt).toBe(42);
    expect(base64ToBytes(first.record.key).byteLength).toBe(32);
    expect(first.record.keyId).toMatch(/^[a-f0-9]{16}$/);
    expect(area.values[AT_REST_KEY_STORAGE_KEY]).toEqual(first.record);
    expect(second).toEqual({ record: first.record, fresh: false });
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it("replaces a malformed stored record with a fresh key", async () => {
    const area = createSessionArea({ [AT_REST_KEY_STORAGE_KEY]: { keyId: "x", key: "short" } });

    const state = await loadOrCreateAtRestKey(area);

    expect(state.fresh).toBe(true);
    expect(parseAtRestKeyRecord(area.values[AT_REST_KEY_STORAGE_KEY])).toEqual(state.record);
  });

  it("refuses to run without chrome.storage.session", async () => {
    await expect(loadOrCreateAtRestKey(undefined)).rejects.toThrow(/storage\.session/);
  });

  it("validates stored records and key messages", () => {
    const record = createAtRestKeyRecord(1, (bytes) => bytes.fill(7));

    expect(parseAtRestKeyRecord(record)).toEqual(record);
    expect(parseAtRestKeyRecord({ ...record, createdAt: Number.NaN })).toBeNull();
    expect(parseAtRestKeyRecord({ ...record, key: btoa("too short") })).toBeNull();
    expect(parseAtRestKeyRecord(null)).toBeNull();

    const message = toStorageKeyMessage(record);
    expect(message).toEqual({
      kind: STORAGE_KEY_MESSAGE_KIND,
      keyId: record.keyId,
      key: record.key
    });
    expect(parseStorageKeyMessage(message)).toEqual(message);
    expect(parseStorageKeyMessage({ ...message, keyId: "NOT-HEX" })).toBeNull();
    expect(parseStorageKeyMessage({ ...message, kind: "sw.other" })).toBeNull();
  });

  it("pins storage.session to trusted contexts", async () => {
    const area = createSessionArea();

    await restrictSessionStorageAccess(area);

    expect(area.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("hands the key only to the extension's own offscreen document", () => {
    expect(isOffscreenDocumentPort({ sender: { url: OFFSCREEN_URL } }, OFFSCREEN_URL)).toBe(true);
    expect(
      isOffscreenDocumentPort({ sender: { url: OFFSCREEN_URL, tab: { id: 1 } } }, OFFSCREEN_URL)
    ).toBe(false);
    expect(
      isOffscreenDocumentPort({ sender: { url: "https://evil.example/" } }, OFFSCREEN_URL)
    ).toBe(false);
    expect(isOffscreenDocumentPort({}, OFFSCREEN_URL)).toBe(false);
  });
});

type StubDeleteRequest = {
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
};

function createStubFactory(outcome: "success" | "blocked" | "error"): {
  factory: IDBFactory;
  deleted: string[];
} {
  const deleted: string[] = [];
  const factory = {
    deleteDatabase(name: string) {
      const request: StubDeleteRequest = {
        error: outcome === "error" ? new DOMException("boom", "UnknownError") : null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };

      deleted.push(name);
      queueMicrotask(() => {
        const handler =
          outcome === "success"
            ? request.onsuccess
            : outcome === "blocked"
              ? request.onblocked
              : request.onerror;
        handler?.();
      });
      return request;
    }
  } as unknown as IDBFactory;

  return { factory, deleted };
}

describe("deletePipelineDatabase", () => {
  it("deletes the named database", async () => {
    const { factory, deleted } = createStubFactory("success");

    await expect(deletePipelineDatabase(factory, "webblackbox-flight-recorder")).resolves.toBe(
      "deleted"
    );
    expect(deleted).toEqual(["webblackbox-flight-recorder"]);
  });

  it("does not wait on a connection that blocks the deletion", async () => {
    const { factory } = createStubFactory("blocked");

    await expect(deletePipelineDatabase(factory, "db")).resolves.toBe("blocked");
  });

  it("rejects when the deletion fails", async () => {
    const { factory } = createStubFactory("error");

    await expect(deletePipelineDatabase(factory, "db")).rejects.toThrow(/boom/);
  });

  it("reports a missing IndexedDB factory instead of throwing", async () => {
    await expect(deletePipelineDatabase(undefined, "any")).resolves.toBe("unavailable");
  });
});
