import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { EventChunker, utf8ByteLength } from "./chunker.js";
import { encodeEventsNdjson } from "./codec.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import { MemoryPipelineStorage } from "./storage.js";

const SESSION: SessionMetadata = {
  sid: "S-chunker",
  tabId: 1,
  startedAt: 1_000,
  mode: "lite",
  url: "https://example.com",
  tags: []
};

function createEvent(id: string, t: number, text: string): WebBlackboxEvent {
  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    t,
    mono: t,
    type: "console.entry",
    id,
    privacy: { category: "console", sensitivity: "medium", redacted: false },
    data: { level: "log", text }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventChunker", () => {
  it("serializes each event once and writes the same NDJSON bytes as encodeEventsNdjson", async () => {
    const events = [
      createEvent("E-1", 1, "plain"),
      createEvent("E-2", 3, "кириллица и 漢字"),
      createEvent("E-3", 2, "emoji 😀")
    ];
    const expected = encodeEventsNdjson(events);
    const chunker = new EventChunker(512 * 1024, "none");
    const stringify = vi.spyOn(JSON, "stringify");

    for (const event of events) {
      await chunker.append(event);
    }

    const chunk = await chunker.flush();

    expect(stringify).toHaveBeenCalledTimes(events.length);
    expect(chunk?.bytes).toEqual(expected);
    expect(chunk?.meta).toMatchObject({
      eventCount: 3,
      tStart: 1,
      tEnd: 3,
      monoStart: 1,
      monoEnd: 3
    });
  });

  it("reports the UTF-8 bytes of each event's line", async () => {
    const chunker = new EventChunker(512 * 1024, "none");
    const event = createEvent("E-1", 1, "кириллица 😀");
    const appended = await chunker.append(event);

    expect(appended.chunk).toBeNull();
    expect(appended.bytes).toBe(new TextEncoder().encode(JSON.stringify(event)).byteLength);
  });

  it("finalizes a chunk once the pending lines reach the size limit", async () => {
    const event = createEvent("E-1", 1, "x".repeat(200));
    const lineLength = JSON.stringify(event).length + 1;
    const chunker = new EventChunker(lineLength * 2, "none");

    expect((await chunker.append(event)).chunk).toBeNull();

    const second = await chunker.append(createEvent("E-2", 2, "x".repeat(200)));

    expect(second.chunk?.meta.eventCount).toBe(2);
    expect(await chunker.flush()).toBeNull();
  });
});

describe("utf8ByteLength", () => {
  it.each(["", "ascii", "é", "кириллица", "漢字", "😀", "a😀b", "\ud800", "x\udc00y"])(
    "matches TextEncoder for %j",
    (text) => {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
    }
  );
});

describe("FlightRecorderPipeline.ingestBatch", () => {
  it("resolves to the stored NDJSON bytes of the batch", async () => {
    const pipeline = new FlightRecorderPipeline({
      session: SESSION,
      storage: new MemoryPipelineStorage()
    });
    const events = [createEvent("E-1", 1, "one"), createEvent("E-2", 2, "два")];

    await pipeline.start();
    const bytes = await pipeline.ingestBatch(events);

    expect(bytes).toBe(
      events.reduce(
        (total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
        0
      )
    );
    expect(await pipeline.ingestBatch([])).toBe(0);
  });
});
