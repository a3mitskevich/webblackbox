import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type {
  ChunkTimeIndexEntry,
  ExportManifest,
  RequestIndexEntry,
  WebBlackboxEvent,
  WebBlackboxEventType
} from "@webblackbox/protocol";

import { WebBlackboxPlayer } from "./index.js";

type ChunkFixture = {
  chunkId: string;
  seq: number;
  /** Events in stored (arrival) order, deliberately not sorted by `mono`. */
  events: WebBlackboxEvent[];
};

/**
 * `legacy` mirrors what pipelines up to this fix wrote (first/last event of the chunk);
 * `exact` is the true min/max of the chunk.
 */
type BoundsMode = "legacy" | "exact";

/**
 * Three chunks in arrival order. Page-side events arrive late, so chunk 2 holds an event older
 * than chunk 1's tail and chunk 3 one older than chunk 2's tail — the shape found in real
 * archives (BACKLOG item 9).
 */
const CHUNKS: ChunkFixture[] = [
  {
    chunkId: "chunk-000001",
    seq: 1,
    events: [
      createEvent("E-03", "user.mousemove", 30),
      createEvent("E-01", "meta.session.start", 0),
      createEvent("E-02", "user.mousemove", 20),
      createEvent("E-04", "user.click", 100),
      createEvent("E-05", "network.request", 150, { reqId: "R-1" })
    ]
  },
  {
    chunkId: "chunk-000002",
    seq: 2,
    events: [
      createEvent("E-06", "network.response", 300, { reqId: "R-1", status: 200 }),
      createEvent("E-08", "network.finished", 400, { reqId: "R-1" }),
      createEvent("E-07", "user.mousemove", 120)
    ]
  },
  {
    chunkId: "chunk-000003",
    seq: 3,
    events: [
      createEvent("E-11", "console.entry", 500, { text: "b" }, { t: 1500 }),
      createEvent("E-13", "storage.session.op", 390),
      createEvent("E-10", "console.entry", 500, { text: "a" }, { t: 1500, lvl: "error" }),
      createEvent("E-12", "user.mousemove", 500, {}, { t: 1499 })
    ]
  }
];

const TIMELINE_ORDER = [
  "E-01",
  "E-02",
  "E-03",
  "E-04",
  "E-07",
  "E-05",
  "E-06",
  "E-13",
  "E-08",
  "E-12",
  "E-10",
  "E-11"
];

describe("archive event order", () => {
  it("exposes all events in mono order despite shuffled chunks and late events", async () => {
    const player = await openFixture("legacy");

    expect(ids(player.events)).toEqual(TIMELINE_ORDER);
    expect(ids(player.query())).toEqual(TIMELINE_ORDER);
  });

  it("keeps filtered, offset and limited queries in mono order", async () => {
    const player = await openFixture("legacy");

    expect(ids(player.query({ types: ["user.mousemove"] }))).toEqual([
      "E-02",
      "E-03",
      "E-07",
      "E-12"
    ]);
    expect(ids(player.query({ types: ["user.mousemove"], offset: 1, limit: 2 }))).toEqual([
      "E-03",
      "E-07"
    ]);
    expect(ids(player.query({ text: "a", types: ["console.entry"] }))).toEqual(["E-10"]);
    expect(ids(player.query({ requestId: "R-1" }))).toEqual(["E-05", "E-06", "E-08"]);
    expect(ids(player.getRequestEvents("R-1"))).toEqual(["E-05", "E-06", "E-08"]);
  });

  it("merges overlapping chunks for ranged queries before everything is loaded", async () => {
    const player = await openFixture("exact");

    expect(ids(player.query({ range: { monoStart: 100, monoEnd: 400 } }))).toEqual([
      "E-04",
      "E-07",
      "E-05",
      "E-06",
      "E-13",
      "E-08"
    ]);
    expect(ids(player.query({ range: { monoStart: 100, monoEnd: 500 }, limit: 3 }))).toEqual([
      "E-04",
      "E-07",
      "E-05"
    ]);
    expect(ids(player.query({ range: { monoStart: 0, monoEnd: 500 } }))).toEqual(TIMELINE_ORDER);
  });

  it("treats inverted legacy index bounds as a span", async () => {
    // Chunk 2's legacy bounds are first=300, last=120.
    const player = await openFixture("legacy");

    expect(ids(player.query({ range: { monoStart: 120, monoEnd: 130 } }))).toEqual(["E-07"]);

    const ranged = await WebBlackboxPlayer.open(await createShuffledArchive("legacy"), {
      range: { monoStart: 120, monoEnd: 130 }
    });
    expect(ids(ranged.events)).toContain("E-07");
  });

  it("widens chunk selection with bounds learned from parsed chunks", async () => {
    const player = await openFixture("legacy");

    // Legacy index bounds say chunk 3 spans 500..500, so its late event at 390 is unknown yet.
    expect(ids(player.query({ range: { monoStart: 380, monoEnd: 395 } }))).toEqual([]);

    player.query({ range: { monoStart: 500, monoEnd: 500 } });

    expect(ids(player.query({ range: { monoStart: 380, monoEnd: 395 } }))).toEqual(["E-13"]);
  });

  it("answers ranged queries exactly once all events are loaded", async () => {
    const player = await openFixture("legacy");

    expect(player.events).toHaveLength(TIMELINE_ORDER.length);
    expect(ids(player.query({ range: { monoStart: 100, monoEnd: 400 } }))).toEqual([
      "E-04",
      "E-07",
      "E-05",
      "E-06",
      "E-13",
      "E-08"
    ]);
    expect(ids(player.query({ range: { monoStart: 390 } }))).toEqual([
      "E-13",
      "E-08",
      "E-12",
      "E-10",
      "E-11"
    ]);
    expect(ids(player.query({ range: { monoEnd: 20 } }))).toEqual(["E-01", "E-02"]);
  });

  it("builds derived spans and the action timeline from ordered events", async () => {
    const player = await openFixture("legacy");
    const derived = player.buildDerived();

    expect(derived.actionSpans).toHaveLength(1);
    expect(derived.actionSpans[0]).toMatchObject({
      triggerEventId: "E-04",
      startMono: 100,
      endMono: 500,
      eventIds: TIMELINE_ORDER.slice(3),
      requestCount: 1,
      errorCount: 1
    });

    const [action] = player.getActionTimeline();
    expect(action).toMatchObject({
      triggerEventId: "E-04",
      endMono: 500,
      requests: [expect.objectContaining({ reqId: "R-1", status: 200 })],
      errors: [expect.objectContaining({ eventId: "E-10" })]
    });

    const [entry] = player.getNetworkWaterfall();
    expect(entry).toMatchObject({ reqId: "R-1", startMono: 150, endMono: 400, status: 200 });
  });
});

function ids(events: WebBlackboxEvent[]): string[] {
  return events.map((event) => event.id);
}

async function openFixture(boundsMode: BoundsMode): Promise<WebBlackboxPlayer> {
  return WebBlackboxPlayer.open(await createShuffledArchive(boundsMode));
}

async function createShuffledArchive(boundsMode: BoundsMode): Promise<Uint8Array> {
  const zip = new JSZip();
  const storedOrder = [CHUNKS[1], CHUNKS[2], CHUNKS[0]].filter((chunk): chunk is ChunkFixture =>
    Boolean(chunk)
  );

  for (const chunk of storedOrder) {
    zip.file(
      `events/${chunk.chunkId}.ndjson`,
      chunk.events.map((event) => JSON.stringify(event)).join("\n")
    );
  }

  const requestIndex: RequestIndexEntry[] = [{ reqId: "R-1", eventIds: ["E-08", "E-05", "E-06"] }];
  const timeIndex = storedOrder.map((chunk) => toTimeIndexEntry(chunk, boundsMode));

  zip.file("index/time.json", JSON.stringify(timeIndex));
  zip.file("index/req.json", JSON.stringify(requestIndex));
  zip.file("index/inv.json", JSON.stringify([]));
  zip.file("manifest.json", JSON.stringify(createManifest()));
  await writeIntegrityManifest(zip);

  return zip.generateAsync({ type: "uint8array" });
}

function toTimeIndexEntry(chunk: ChunkFixture, boundsMode: BoundsMode): ChunkTimeIndexEntry {
  const monos = chunk.events.map((event) => event.mono);
  const walls = chunk.events.map((event) => event.t);
  const first = chunk.events[0];
  const last = chunk.events[chunk.events.length - 1];
  const isLegacy = boundsMode === "legacy";

  return {
    chunkId: chunk.chunkId,
    seq: chunk.seq,
    tStart: isLegacy ? (first?.t ?? 0) : Math.min(...walls),
    tEnd: isLegacy ? (last?.t ?? 0) : Math.max(...walls),
    monoStart: isLegacy ? (first?.mono ?? 0) : Math.min(...monos),
    monoEnd: isLegacy ? (last?.mono ?? 0) : Math.max(...monos),
    eventCount: chunk.events.length,
    byteLength: 1,
    codec: "none",
    sha256: "unused"
  };
}

function createEvent(
  id: string,
  type: WebBlackboxEventType,
  mono: number,
  data: Record<string, unknown> = {},
  extra: Partial<Pick<WebBlackboxEvent, "t" | "lvl">> = {}
): WebBlackboxEvent {
  return { v: 1, sid: "S-ORDER", tab: 1, t: 1000 + mono, mono, type, id, data, ...extra };
}

function createManifest(): ExportManifest {
  return {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://example.com" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: { eventCount: 12, chunkCount: 3, blobCount: 0, durationMs: 500 }
  };
}

async function writeIntegrityManifest(zip: JSZip): Promise<void> {
  const files: Record<string, string> = {};

  for (const path of Object.keys(zip.files).sort()) {
    const file = zip.file(path);

    if (file) {
      files[path] = await sha256Hex(await file.async("uint8array"));
    }
  }

  zip.file(
    "integrity/hashes.json",
    JSON.stringify({ manifestSha256: files["manifest.json"] ?? "", files })
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
