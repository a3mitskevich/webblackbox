import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FlightRecorderPipeline,
  INVERTED_INDEX_LIMITS,
  MemoryPipelineStorage
} from "@webblackbox/pipeline";
import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { WebBlackboxPlayer } from "./index.js";

// Archives written by the pipeline before the streaming exporter (JSZip, pretty-printed
// indexes, `none` chunk codec): see test-support/fixtures/README.md.
const FIXTURES = new URL("./test-support/fixtures/", import.meta.url);
const LEGACY_PASSPHRASE = "legacy-fixture-passphrase";
const SID = "S-legacy-fixture";
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);
const BODY_TEXT = '{"error":"gateway timeout"}';
const EXPECTED_EVENT_IDS = ["E-1", "E-2", "E-3", "E-4", "E-5"];

async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

/** The session the fixtures were recorded from, exported by the current pipeline. */
async function exportCurrentArchive(): Promise<Uint8Array> {
  const pipeline = new FlightRecorderPipeline({
    session: {
      sid: SID,
      tabId: 1,
      startedAt: T0,
      endedAt: T0 + 1000,
      mode: "full",
      url: "https://shop.example.test/cart",
      tags: []
    },
    storage: new MemoryPipelineStorage(),
    maxChunkBytes: 400,
    chunkCodec: "gzip"
  });

  await pipeline.start();
  const bodyHash = await pipeline.putBlob("application/json", new TextEncoder().encode(BODY_TEXT));

  for (const event of createFixtureEvents(bodyHash)) {
    await pipeline.ingest(event);
  }

  const exported = await pipeline.exportBundle({
    passphrase: LEGACY_PASSPHRASE,
    includeScreenshots: true,
    includeScreenRecordings: true,
    maxArchiveBytes: null,
    recentWindowMs: null
  });

  return exported.bytes;
}

function createFixtureEvents(bodyHash: string): WebBlackboxEvent[] {
  const base = (id: string, step: number) => ({
    v: 1 as const,
    sid: SID,
    tab: 1,
    id,
    t: T0 + step * 100,
    mono: step * 100
  });

  return [
    {
      ...base("E-1", 1),
      type: "nav.commit",
      privacy: { category: "system", sensitivity: "low", redacted: true },
      data: { url: "https://shop.example.test/cart" }
    },
    {
      ...base("E-2", 2),
      type: "user.click",
      privacy: { category: "actions", sensitivity: "low", redacted: true },
      data: { selector: "#checkout", x: 10, y: 20 }
    },
    {
      ...base("E-3", 3),
      type: "network.request",
      privacy: { category: "network", sensitivity: "low", redacted: true },
      data: { reqId: "R-1", method: "POST", url: "https://shop.example.test/api/checkout" }
    },
    {
      ...base("E-4", 4),
      type: "network.response",
      privacy: { category: "network", sensitivity: "low", redacted: true },
      data: { reqId: "R-1", status: 500, mimeType: "application/json", bodyHash }
    },
    {
      ...base("E-5", 5),
      type: "console.entry",
      lvl: "error",
      privacy: { category: "console", sensitivity: "low", redacted: true },
      data: { level: "error", text: "checkout failed: payment gateway timeout", source: "app" }
    }
  ];
}

async function expectFixtureSession(player: WebBlackboxPlayer): Promise<void> {
  expect(player.events.map((event) => event.id)).toEqual(EXPECTED_EVENT_IDS);
  expect(player.query({ types: ["network.request"] }).map((event) => event.id)).toEqual(["E-3"]);
  expect(player.query({ text: "gateway" }).map((event) => event.id)).toEqual(["E-5"]);
  expect(player.query({ text: "checkout" }).map((event) => event.id)).toEqual(
    expect.arrayContaining(["E-2", "E-5"])
  );
  expect(player.search("timeout").map((result) => result.eventId)).toContain("E-5");
  expect(player.getRequestEvents("R-1").map((event) => event.id)).toEqual(["E-3", "E-4"]);

  const response = player.query({ types: ["network.response"] })[0];
  const bodyHash = (response?.data as { bodyHash?: string } | undefined)?.bodyHash ?? "";
  const blob = await player.getBlob(bodyHash);

  expect(new TextDecoder().decode(blob?.bytes)).toBe(BODY_TEXT);
}

describe("archive compatibility", () => {
  it("opens a format 1 archive (plaintext manifest, no encryption)", async () => {
    const player = await WebBlackboxPlayer.open(await readFixture("legacy-format1.webblackbox"));

    expect(player.archive.manifest.protocolVersion).toBe(1);
    await expectFixtureSession(player);
  });

  it("opens a format 2 archive written by the JSZip exporter", async () => {
    const bytes = await readFixture("legacy-format2.webblackbox");

    await expect(WebBlackboxPlayer.open(bytes)).rejects.toThrow(/encrypted/i);

    const player = await WebBlackboxPlayer.open(bytes, { passphrase: LEGACY_PASSPHRASE });

    expect(player.archive.manifest.protocolVersion).toBe(2);
    expect(player.archive.manifest.chunkCodec).toBe("none");
    await expectFixtureSession(player);
  });

  it("opens the same session exported by the current pipeline (gzip chunks)", async () => {
    const player = await WebBlackboxPlayer.open(await exportCurrentArchive(), {
      passphrase: LEGACY_PASSPHRASE
    });

    expect(player.archive.manifest.protocolVersion).toBe(2);
    expect(player.archive.manifest.chunkCodec).toBe("gzip");
    expect(player.archive.timeIndex.every((entry) => entry.codec === "gzip")).toBe(true);
    await expectFixtureSession(player);
  });

  it("finds events by terms the bounded inverted index leaves out", async () => {
    const count = INVERTED_INDEX_LIMITS.minEventsForDocumentCutoff + 100;
    const pipeline = new FlightRecorderPipeline({
      session: {
        sid: SID,
        tabId: 1,
        startedAt: T0,
        mode: "lite",
        url: "https://x.test/",
        tags: []
      },
      storage: new MemoryPipelineStorage(),
      chunkCodec: "gzip"
    });

    await pipeline.start();

    for (let index = 0; index < count; index += 1) {
      await pipeline.ingest({
        v: 1,
        sid: SID,
        tab: 1,
        id: `E-${index}`,
        t: T0 + index,
        mono: index,
        type: "user.click",
        privacy: { category: "actions", sensitivity: "low", redacted: true },
        data: { selector: "#save", label: `rare-${index}` }
      });
    }

    const exported = await pipeline.exportBundle({
      passphrase: LEGACY_PASSPHRASE,
      maxArchiveBytes: null,
      recentWindowMs: null
    });
    const player = await WebBlackboxPlayer.open(exported.bytes, {
      passphrase: LEGACY_PASSPHRASE
    });
    const terms = new Set(player.archive.invertedIndex.map((entry) => entry.term));

    expect(terms.has("save")).toBe(false);
    expect(terms.has("rare-7")).toBe(true);
    expect(player.query({ text: "save" })).toHaveLength(count);
    expect(player.query({ text: "rare-7" }).map((event) => event.id)).toEqual(["E-7"]);
    expect(player.search("save", count)).toHaveLength(count);
  });
});
