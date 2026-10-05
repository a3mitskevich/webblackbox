import type { SessionMetadata } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { sweepPipelineSessions } from "./session-sweep.js";
import { MemoryPipelineStorage, type PipelineStorage } from "./storage.js";

function session(sid: string, startedAt: number): SessionMetadata {
  return {
    sid,
    tabId: 1,
    startedAt,
    mode: "lite",
    url: "https://example.com/",
    tags: []
  };
}

describe("sweepPipelineSessions", () => {
  it("deletes sessions selected by the predicate together with their blobs", async () => {
    const storage = new MemoryPipelineStorage();
    const hash = "e".repeat(64);

    await storage.putSession(session("S-old", 1));
    await storage.putSession(session("S-keep", 2));
    await storage.putBlob(
      {
        hash,
        mime: "image/png",
        size: 1,
        bytes: Uint8Array.from([1]),
        createdAt: 1,
        refCount: 1
      },
      "S-old"
    );

    const result = await sweepPipelineSessions(storage, (row) => row.sid === "S-old");

    expect(result).toEqual({ deleted: ["S-old"], failed: [] });
    await expect(storage.listSessions()).resolves.toEqual([session("S-keep", 2)]);
    await expect(storage.getBlob(hash)).resolves.toBeUndefined();
  });

  it("keeps sweeping when one session fails to delete", async () => {
    const inner = new MemoryPipelineStorage();
    await inner.putSession(session("S-broken", 1));
    await inner.putSession(session("S-ok", 2));

    const storage: PipelineStorage = {
      ...bindStorage(inner),
      deleteSession: async (sid: string) => {
        if (sid === "S-broken") {
          throw new Error("disk on fire");
        }

        await inner.deleteSession(sid);
      }
    };

    const result = await sweepPipelineSessions(storage, () => true);

    expect(result.deleted).toEqual(["S-ok"]);
    expect(result.failed).toEqual([{ sid: "S-broken", error: "disk on fire" }]);
  });

  it("rejects storages that cannot list sessions", async () => {
    const withoutListing: PipelineStorage = {
      ...bindStorage(new MemoryPipelineStorage()),
      listSessions: undefined
    };

    await expect(sweepPipelineSessions(withoutListing, () => true)).rejects.toThrow(
      /does not support listing sessions/
    );
  });

  it("does nothing when no session matches", async () => {
    const storage = new MemoryPipelineStorage();
    await storage.putSession(session("S-live", 1));

    await expect(sweepPipelineSessions(storage, () => false)).resolves.toEqual({
      deleted: [],
      failed: []
    });
    await expect(storage.listSessions()).resolves.toHaveLength(1);
  });
});

function bindStorage(storage: MemoryPipelineStorage): PipelineStorage {
  return {
    putSession: (metadata) => storage.putSession(metadata),
    getSession: (sid) => storage.getSession(sid),
    listSessions: () => storage.listSessions(),
    putChunk: (chunk) => storage.putChunk(chunk),
    listChunks: (sid) => storage.listChunks(sid),
    getLatestChunkMeta: (sid) => storage.getLatestChunkMeta(sid),
    getChunk: (sid, chunkId) => storage.getChunk(sid, chunkId),
    putBlob: (blob, sidHint) => storage.putBlob(blob, sidHint),
    getBlob: (hash) => storage.getBlob(hash),
    listBlobs: () => storage.listBlobs(),
    putIndexes: (sid, indexes) => storage.putIndexes(sid, indexes),
    getIndexes: (sid) => storage.getIndexes(sid),
    putIntegrity: (sid, manifest) => storage.putIntegrity(sid, manifest),
    getIntegrity: (sid) => storage.getIntegrity(sid),
    deleteSession: (sid, blobHashes) => storage.deleteSession(sid, blobHashes)
  };
}
