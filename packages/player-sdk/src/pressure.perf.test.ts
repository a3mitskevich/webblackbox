import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ChunkTimeIndexEntry, ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import { WebBlackboxPlayer } from "./index.js";
import { sha256HexForTest, writeIntegrityManifest } from "./test-support/archive-integrity.js";

// Load test: builds and parses a 16 MB+ archive. Its run time measures the machine, so it lives in
// the perf project (`pnpm --filter @webblackbox/player-sdk test:pressure`, vitest.perf.config.ts)
// and stays out of `pnpm test`.
describe("WebBlackboxPlayer pressure", () => {
  it("keeps large archive player pressure paths bounded", async () => {
    const bytes = await createLargePressureArchive();
    const heapSamples = [process.memoryUsage().heapUsed];
    const player = await WebBlackboxPlayer.open(bytes);
    heapSamples.push(process.memoryUsage().heapUsed);

    const searchResults = player.search("large-session-checkpoint", 25);
    heapSamples.push(process.memoryUsage().heapUsed);
    const networkWaterfall = player.getNetworkWaterfall();
    heapSamples.push(process.memoryUsage().heapUsed);
    const actionTimeline = player.getActionTimeline();
    heapSamples.push(process.memoryUsage().heapUsed);
    const replayDiagnostics = player.getReplayDiagnostics({
      actions: actionTimeline,
      waterfall: networkWaterfall
    });
    heapSamples.push(process.memoryUsage().heapUsed);
    const domSnapshots = player.getDomSnapshots();
    heapSamples.push(process.memoryUsage().heapUsed);
    const firstScreenshot = await player.getBlob("large-shot-0000");
    const firstResponseBody = await player.getBlob("large-body-0000");
    heapSamples.push(process.memoryUsage().heapUsed);
    const heapPeak = Math.max(...heapSamples);
    const heapBaseline = Math.min(...heapSamples);

    expect(bytes.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(player.events.length).toBeGreaterThan(30_000);
    expect(searchResults).toHaveLength(25);
    expect(networkWaterfall).toHaveLength(6_000);
    expect(actionTimeline).toHaveLength(6_000);
    expect(replayDiagnostics).toHaveLength(6_000);
    expect(domSnapshots).toHaveLength(300);
    expect(firstScreenshot?.bytes.byteLength).toBe(32 * 1024);
    expect(firstResponseBody?.bytes.byteLength).toBe(16 * 1024);
    expect(heapPeak - heapBaseline).toBeLessThan(512 * 1024 * 1024);
  });
});

async function createLargePressureArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  const sid = "S-large-pressure";
  const baseWall = 1_700_000_000_000;
  const events: WebBlackboxEvent[] = [
    {
      v: 1,
      sid,
      tab: 1,
      t: baseWall,
      mono: 0,
      type: "meta.session.start",
      id: "E-large-start",
      data: {
        url: "https://large.example.test"
      }
    }
  ];
  const requestIndex: Array<{ reqId: string; eventIds: string[] }> = [];
  const invertedIndex: Array<{ term: string; eventIds: string[] }> = [
    {
      term: "large-session-checkpoint",
      eventIds: []
    }
  ];
  const requestCount = 6_000;
  const screenshotBytes = Uint8Array.from({ length: 32 * 1024 }, (_, index) => index % 251);
  const responseBytes = new TextEncoder().encode("x".repeat(16 * 1024));

  for (let index = 0; index < requestCount; index += 1) {
    const mono = index * 125 + 10;
    const actionId = `A-large-${index.toString().padStart(4, "0")}`;
    const reqId = `R-large-${index.toString().padStart(4, "0")}`;
    const bodyHash = `large-body-${index.toString().padStart(4, "0")}`;
    const eventIds: string[] = [];

    const clickId = `E-large-${index.toString().padStart(4, "0")}-click`;
    const requestId = `E-large-${index.toString().padStart(4, "0")}-request`;
    const responseId = `E-large-${index.toString().padStart(4, "0")}-response`;
    const bodyId = `E-large-${index.toString().padStart(4, "0")}-body`;
    const consoleId = `E-large-${index.toString().padStart(4, "0")}-console`;

    events.push(
      {
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono,
        mono,
        type: "user.click",
        id: clickId,
        ref: {
          act: actionId
        },
        data: {
          target: {
            selector: `button[data-row="${index}"]`,
            text: `Open row ${index}`
          }
        }
      },
      {
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono + 5,
        mono: mono + 5,
        type: "network.request",
        id: requestId,
        ref: {
          act: actionId,
          req: reqId
        },
        data: {
          reqId,
          method: "POST",
          url: `https://large.example.test/api/items/${index}`,
          requestBodyText: JSON.stringify({ index, token: "[REDACTED]" })
        }
      },
      {
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono + 35,
        mono: mono + 35,
        type: "network.response",
        id: responseId,
        ref: {
          act: actionId,
          req: reqId
        },
        data: {
          reqId,
          status: index % 29 === 0 ? 503 : 200,
          statusText: index % 29 === 0 ? "Service Unavailable" : "OK",
          mimeType: "application/json",
          encodedDataLength: responseBytes.byteLength
        }
      },
      {
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono + 38,
        mono: mono + 38,
        type: "network.body",
        id: bodyId,
        ref: {
          act: actionId,
          req: reqId
        },
        data: {
          reqId,
          contentHash: bodyHash,
          size: responseBytes.byteLength
        }
      },
      {
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono + 42,
        mono: mono + 42,
        type: "console.entry",
        id: consoleId,
        data: {
          level: "info",
          text: `large-session-checkpoint ${index}`
        }
      }
    );

    eventIds.push(requestId, responseId, bodyId);
    requestIndex.push({ reqId, eventIds });
    invertedIndex[0]?.eventIds.push(consoleId);

    if (index % 12 === 0) {
      const shotHash = `large-shot-${index.toString().padStart(4, "0")}`;
      events.push({
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono + 55,
        mono: mono + 55,
        type: "screen.screenshot",
        id: `E-large-${index.toString().padStart(4, "0")}-shot`,
        ref: {
          act: actionId,
          shot: shotHash
        },
        data: {
          shotId: shotHash,
          format: "webp",
          reason: "pressure",
          size: screenshotBytes.byteLength
        }
      });
      zip.file(`blobs/sha256-${shotHash}.webp`, screenshotBytes);
    }

    if (index % 20 === 0) {
      events.push({
        v: 1,
        sid,
        tab: 1,
        t: baseWall + mono + 60,
        mono: mono + 60,
        type: "dom.snapshot",
        id: `E-large-${index.toString().padStart(4, "0")}-dom`,
        data: {
          snapshotId: `DOM-${index}`,
          contentHash: `large-dom-${index.toString().padStart(4, "0")}`,
          nodeCount: 1_000 + index,
          reason: "pressure"
        }
      });
    }

    if (index % 4 === 0) {
      zip.file(`blobs/sha256-${bodyHash}.json`, responseBytes);
    }
  }

  const chunkSize = 500;
  const timeIndex: ChunkTimeIndexEntry[] = [];

  for (let chunkIndex = 0; chunkIndex * chunkSize < events.length; chunkIndex += 1) {
    const chunkEvents = events.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
    const chunkId = `C-large-${(chunkIndex + 1).toString().padStart(6, "0")}`;
    const content = chunkEvents.map((event) => JSON.stringify(event)).join("\n");
    const bytes = new TextEncoder().encode(content);
    zip.file(`events/${chunkId}.ndjson`, bytes);
    timeIndex.push({
      chunkId,
      seq: chunkIndex + 1,
      tStart: chunkEvents[0]?.t ?? baseWall,
      tEnd: chunkEvents[chunkEvents.length - 1]?.t ?? baseWall,
      monoStart: chunkEvents[0]?.mono ?? 0,
      monoEnd: chunkEvents[chunkEvents.length - 1]?.mono ?? 0,
      eventCount: chunkEvents.length,
      byteLength: bytes.byteLength,
      codec: "none",
      sha256: await sha256HexForTest(bytes)
    });
  }

  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: {
      origin: "https://large.example.test",
      title: "Large Pressure Fixture"
    },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: ["authorization", "cookie", "set-cookie"],
      redactCookieNames: ["token", "session", "auth"],
      redactBodyPatterns: ["password", "token", "secret"],
      blockedSelectors: ["input[type='password']"],
      hashSensitiveValues: true
    },
    stats: {
      eventCount: events.length,
      chunkCount: timeIndex.length,
      blobCount: 150,
      durationMs: events[events.length - 1]?.mono ?? 0
    }
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", JSON.stringify(timeIndex));
  zip.file("index/req.json", JSON.stringify(requestIndex));
  zip.file("index/inv.json", JSON.stringify(invertedIndex));

  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}
