import { describe, expect, it, vi } from "vitest";

import type { ChunkCodec, SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { readWebBlackboxArchive } from "./exporter.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import { MemoryPipelineStorage } from "./storage.js";

// Re-encoding a filtered chunk can fall back to "none" on the write pass (a compression timeout)
// after it compressed while the export was planned: here the second gzip encode of the same
// events falls back.
const codecFallback = vi.hoisted(() => ({ enabled: false, encoded: new Set<string>() }));

vi.mock("./codec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codec.js")>();

  return {
    ...actual,
    encodeChunkEvents: (events: WebBlackboxEvent[], codec: ChunkCodec) => {
      const key = events[0]?.id ?? "";

      if (!codecFallback.enabled || codec !== "gzip") {
        return actual.encodeChunkEvents(events, codec);
      }

      if (codecFallback.encoded.has(key)) {
        return actual.encodeChunkEvents(events, "none");
      }

      codecFallback.encoded.add(key);
      return actual.encodeChunkEvents(events, codec);
    }
  };
});

const PASSPHRASE = "session-export-passphrase";
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const SESSION: SessionMetadata = {
  sid: "S-session-export-codec",
  tabId: 1,
  startedAt: T0,
  endedAt: T0 + 60_000,
  mode: "full",
  url: "https://example.test/app",
  tags: []
};

/** Console text, with a screenshot every 5th event (left out by the default policy). */
function createEvent(index: number): WebBlackboxEvent {
  const isScreenshot = index % 5 === 0;

  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    id: `E-${String(index).padStart(4, "0")}`,
    t: T0 + index * 100,
    mono: index * 100,
    type: isScreenshot ? "screen.screenshot" : "console.entry",
    privacy: {
      category: isScreenshot ? "screenshots" : "console",
      sensitivity: "low",
      redacted: true
    },
    data: isScreenshot
      ? { shotId: `shot-${index}`, format: "webp" }
      : { level: "log", text: `message ${index} `.repeat(20) }
  };
}

describe("streaming session export codec fallback", () => {
  it("describes a re-encoded chunk with the codec it was written with", async () => {
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage: new MemoryPipelineStorage(),
      maxChunkBytes: 2 * 1024,
      chunkCodec: "gzip"
    });
    const keptIds: string[] = [];

    await pipeline.start();

    for (let index = 0; index < 60; index += 1) {
      const event = createEvent(index);

      if (event.type !== "screen.screenshot") {
        keptIds.push(event.id);
      }

      await pipeline.ingest(event);
    }

    await pipeline.flush();
    codecFallback.enabled = true;

    try {
      const exported = await pipeline.exportBundle({
        passphrase: PASSPHRASE,
        maxArchiveBytes: null,
        recentWindowMs: null
      });
      const parsed = await readWebBlackboxArchive(exported.bytes, { passphrase: PASSPHRASE });

      expect(codecFallback.encoded.size).toBeGreaterThan(0);
      expect(parsed.timeIndex.every((meta) => meta.codec === "none")).toBe(true);
      expect(parsed.events.map((event) => event.id)).toEqual(keptIds);
    } finally {
      codecFallback.enabled = false;
    }
  });
});
