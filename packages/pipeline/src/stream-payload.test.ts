import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { SessionMetadata, WebBlackboxEvent } from "@webblackbox/protocol";

import { readWebBlackboxArchive } from "./exporter.js";
import { sha256Hex } from "./hash.js";
import { FlightRecorderPipeline } from "./pipeline.js";
import { MemoryPipelineStorage } from "./storage.js";
import { MAX_INLINE_STREAM_PAYLOAD_CHARS, STREAM_PAYLOAD_PREVIEW_CHARS } from "./stream-payload.js";

const SESSION: SessionMetadata = {
  sid: "S-stream-payload",
  tabId: 1,
  startedAt: 1_700_000_000_000,
  mode: "full",
  url: "https://app.example.com",
  tags: []
};
const EXPORT_OPTIONS = {
  includeScreenshots: false,
  includeScreenRecordings: false,
  maxArchiveBytes: null,
  recentWindowMs: null
} as const;

function signalRFrame(chars: number): string {
  const record = `${JSON.stringify({ type: 1, target: "GameState", arguments: [{ state: 4 }] })}\u001e`;
  return record.repeat(Math.ceil(chars / record.length)).slice(0, chars);
}

function networkEvent(
  id: string,
  type: WebBlackboxEvent["type"],
  data: Record<string, unknown>
): WebBlackboxEvent {
  return {
    v: 1,
    sid: SESSION.sid,
    tab: 1,
    t: 1_700_000_000_000,
    mono: 1,
    type,
    id,
    privacy: { category: "network", sensitivity: "medium", redacted: false },
    data
  };
}

function wsFrame(id: string, payload: string, extra: Record<string, unknown> = {}) {
  return networkEvent(id, "network.ws.frame", {
    requestId: "ws-1",
    direction: "received",
    frame: { opcode: 1, payloadLength: payload.length, payloadPreview: payload, ...extra }
  });
}

async function exportEvents(events: WebBlackboxEvent[]) {
  const storage = new MemoryPipelineStorage();
  const pipeline = new FlightRecorderPipeline({ session: SESSION, storage });

  await pipeline.start();
  await pipeline.ingest(events[0]!);
  await pipeline.ingestBatch(events.slice(1));
  const exported = await pipeline.exportBundle(EXPORT_OPTIONS);
  const zip = await JSZip.loadAsync(exported.bytes);
  const parsed = await readWebBlackboxArchive(exported.bytes);
  const byId = new Map(parsed.events.map((event) => [event.id, event]));

  return {
    byId,
    readBlobText: async (hash: string): Promise<string | null> => {
      const path = Object.keys(zip.files).find((name) => name.startsWith(`blobs/sha256-${hash}.`));
      const file = path ? zip.file(path) : null;
      return file ? file.async("string") : null;
    }
  };
}

function readData(event: WebBlackboxEvent | undefined): Record<string, unknown> {
  return (event?.data ?? {}) as Record<string, unknown>;
}

describe("large stream payloads move to blobs", () => {
  it("stores a 40 KB WebSocket frame as a content-addressed blob with an inline head", async () => {
    const big = signalRFrame(40_000);
    const { byId, readBlobText } = await exportEvents([
      wsFrame("E-small", signalRFrame(10_000)),
      wsFrame("E-big", big, { payloadTruncated: true })
    ]);
    const bigFrame = readData(byId.get("E-big")).frame as Record<string, unknown>;
    const smallFrame = readData(byId.get("E-small")).frame as Record<string, unknown>;
    const hash = await sha256Hex(new TextEncoder().encode(big));

    expect(smallFrame.payloadPreview).toBe(signalRFrame(10_000));
    expect(bigFrame).toMatchObject({
      opcode: 1,
      payloadLength: big.length,
      payloadHash: hash,
      payloadTruncated: true
    });
    expect(bigFrame.payloadPreview).toBe(big.slice(0, STREAM_PAYLOAD_PREVIEW_CHARS));
    expect(await readBlobText(hash)).toBe(big);
  });

  it("keeps frames up to the inline limit inline", async () => {
    const atLimit = signalRFrame(MAX_INLINE_STREAM_PAYLOAD_CHARS);
    const { byId } = await exportEvents([wsFrame("E-limit", atLimit)]);
    const frame = readData(byId.get("E-limit")).frame as Record<string, unknown>;

    expect(frame.payloadPreview).toBe(atLimit);
    expect(frame.payloadHash).toBeUndefined();
  });

  it("stores large SSE message data the same way", async () => {
    const data = JSON.stringify({ odds: Array.from({ length: 4_000 }, (_, index) => index) });
    const { byId, readBlobText } = await exportEvents([
      networkEvent("E-sse", "network.sse.message", { requestId: "sse-1", phase: "message", data })
    ]);
    const stored = readData(byId.get("E-sse"));

    expect(data.length).toBeGreaterThan(MAX_INLINE_STREAM_PAYLOAD_CHARS);
    expect(stored.data).toBe(data.slice(0, STREAM_PAYLOAD_PREVIEW_CHARS));
    expect(await readBlobText(stored.dataHash as string)).toBe(data);
  });

  it("does not split a surrogate pair at the end of the inline head", async () => {
    const big = `${"a".repeat(STREAM_PAYLOAD_PREVIEW_CHARS - 1)}😀${"b".repeat(20_000)}`;
    const { byId } = await exportEvents([wsFrame("E-emoji", big)]);
    const frame = readData(byId.get("E-emoji")).frame as Record<string, unknown>;

    expect(frame.payloadPreview).toBe("a".repeat(STREAM_PAYLOAD_PREVIEW_CHARS - 1));
  });

  it("leaves other events alone", async () => {
    const request = networkEvent("E-req", "network.request", {
      requestId: "r-1",
      request: { url: "https://app.example.com/api", postData: "x".repeat(30_000) }
    });
    const { byId } = await exportEvents([request]);

    expect(byId.get("E-req")?.data).toEqual(request.data);
  });
});
