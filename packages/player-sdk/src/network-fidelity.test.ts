import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import { WebBlackboxPlayer } from "./index.js";

type EventInput = Pick<WebBlackboxEvent, "type" | "data"> & { mono: number; req?: string };

const SIGNALR_FRAME = `${JSON.stringify({
  type: 3,
  invocationId: "0",
  result: { data: Array.from({ length: 120 }, (_, index) => ({ gameId: index, state: 4 })) }
})}\u001e`;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function buildArchive(
  inputs: EventInput[],
  blobs: Array<{ text: string }> = []
): Promise<Uint8Array> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = inputs.map((input, index) => ({
    v: 1,
    sid: "S-fidelity",
    tab: 1,
    t: 1_000 + input.mono,
    mono: input.mono,
    type: input.type,
    id: `E-${index + 1}`,
    ...(input.req ? { ref: { req: input.req } } : {}),
    data: input.data
  }));
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://app.example.com", title: "Fidelity" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: 1,
      blobCount: blobs.length,
      durationMs: 10
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify([]));
  zip.file("index/req.json", JSON.stringify([]));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));

  for (const blob of blobs) {
    const bytes = new TextEncoder().encode(blob.text);
    zip.file(`blobs/sha256-${sha256Hex(bytes)}.txt`, bytes);
  }

  const files: Record<string, string> = {};

  for (const path of Object.keys(zip.files).sort()) {
    const file = zip.file(path);

    if (file) {
      files[path] = sha256Hex(await file.async("uint8array"));
    }
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: files["manifest.json"] ?? "", files })
  );

  return zip.generateAsync({ type: "uint8array" });
}

function request(reqId: string, mono: number, url = `https://cdn.example.com/${reqId}.jpg`) {
  return {
    type: "network.request" as const,
    mono,
    req: reqId,
    data: { requestId: reqId, type: "Image", request: { url, method: "GET" } }
  };
}

describe("network waterfall cache and pending state", () => {
  it("labels memory-cache hits and closes them even without a response", async () => {
    const player = await WebBlackboxPlayer.open(
      await buildArchive([
        request("mem", 1),
        {
          type: "network.response",
          mono: 2,
          req: "mem",
          data: {
            requestId: "mem",
            response: { status: 200, mimeType: "image/jpeg", fromMemoryCache: true }
          }
        },
        {
          type: "network.finished",
          mono: 3,
          req: "mem",
          data: { requestId: "mem", fromMemoryCache: true }
        },
        request("served", 4),
        {
          type: "network.finished",
          mono: 6,
          req: "served",
          data: { requestId: "served", fromMemoryCache: true }
        }
      ])
    );
    const byId = new Map(player.getNetworkWaterfall().map((entry) => [entry.reqId, entry]));

    expect(byId.get("mem")).toMatchObject({ status: 200, fromCache: "memory" });
    expect(byId.get("mem")?.pending).toBeUndefined();
    expect(byId.get("served")).toMatchObject({ fromCache: "memory", durationMs: 2 });
    expect(byId.get("served")?.status).toBeUndefined();
    expect(byId.get("served")?.pending).toBeUndefined();
  });

  it("labels disk, prefetch and service-worker responses", async () => {
    const player = await WebBlackboxPlayer.open(
      await buildArchive(
        (
          [
            ["disk", { fromDiskCache: true }],
            ["prefetch", { fromPrefetchCache: true }],
            ["sw", { fromServiceWorker: true }],
            ["net", { fromDiskCache: false }]
          ] as const
        ).flatMap(([reqId, flags], index) => [
          request(reqId, index * 2 + 1),
          {
            type: "network.response" as const,
            mono: index * 2 + 2,
            req: reqId,
            data: { requestId: reqId, response: { status: 200, ...flags } }
          }
        ])
      )
    );
    const byId = new Map(player.getNetworkWaterfall().map((entry) => [entry.reqId, entry]));

    expect(byId.get("disk")?.fromCache).toBe("disk");
    expect(byId.get("prefetch")?.fromCache).toBe("prefetch");
    expect(byId.get("sw")?.fromCache).toBe("service-worker");
    expect(byId.get("net")?.fromCache).toBeUndefined();
  });

  it("marks only requests without any response, finish or failure as pending", async () => {
    const player = await WebBlackboxPlayer.open(
      await buildArchive([
        request("stalled", 1),
        request("failed", 2),
        {
          type: "network.failed",
          mono: 3,
          req: "failed",
          data: { requestId: "failed", errorText: "net::ERR_CONNECTION_RESET" }
        }
      ])
    );
    const byId = new Map(player.getNetworkWaterfall().map((entry) => [entry.reqId, entry]));

    expect(byId.get("stalled")?.pending).toBe(true);
    expect(byId.get("failed")?.pending).toBeUndefined();
    expect(byId.get("failed")?.failed).toBe(true);
  });
});

describe("realtime payloads", () => {
  it("returns full inline frames and loads blob-stored frames by hash", async () => {
    const bigFrame = SIGNALR_FRAME.repeat(12);
    const bigHash = sha256Hex(new TextEncoder().encode(bigFrame));
    const player = await WebBlackboxPlayer.open(
      await buildArchive(
        [
          {
            type: "network.ws.frame",
            mono: 1,
            data: {
              requestId: "ws-1",
              direction: "received",
              frame: {
                opcode: 1,
                payloadLength: SIGNALR_FRAME.length,
                payloadPreview: SIGNALR_FRAME
              }
            }
          },
          {
            type: "network.ws.frame",
            mono: 2,
            data: {
              requestId: "ws-1",
              direction: "sent",
              frame: {
                opcode: 1,
                payloadLength: bigFrame.length,
                payloadPreview: bigFrame.slice(0, 512),
                payloadHash: bigHash,
                payloadTruncated: true
              }
            }
          },
          {
            type: "network.sse.message",
            mono: 3,
            data: {
              requestId: "sse-1",
              phase: "message",
              data: bigFrame.slice(0, 512),
              dataHash: bigHash
            }
          }
        ],
        [{ text: bigFrame }]
      )
    );
    const [inline, blob, sse] = player.getRealtimeNetworkTimeline();

    expect(inline?.payloadPreview).toBe(SIGNALR_FRAME);
    expect(inline?.payloadHash).toBeUndefined();
    expect(blob).toMatchObject({ payloadHash: bigHash, payloadTruncated: true });
    expect(sse).toMatchObject({ protocol: "sse", payloadHash: bigHash });

    expect(await player.getRealtimePayloadText(inline!.eventId)).toBe(SIGNALR_FRAME);
    expect(await player.getRealtimePayloadText(blob!.eventId)).toBe(bigFrame);
    expect(await player.getRealtimePayloadText(sse!.eventId)).toBe(bigFrame);
    expect(await player.getRealtimePayloadText("E-missing")).toBeNull();
  });
});
