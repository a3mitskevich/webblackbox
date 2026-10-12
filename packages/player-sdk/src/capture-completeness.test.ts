import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import { formatCaptureCompletenessReport, readExportCompleteness } from "./capture-completeness.js";
import { WebBlackboxPlayer } from "./index.js";

type EventInput = Pick<WebBlackboxEvent, "type" | "data"> & { mono: number };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function openArchive(
  inputs: EventInput[],
  manifestPatch: Partial<ExportManifest> = {}
): Promise<WebBlackboxPlayer> {
  const zip = new JSZip();
  const events: WebBlackboxEvent[] = inputs.map((input, index) => ({
    v: 1,
    sid: "S-completeness",
    tab: 1,
    t: 1_000 + input.mono,
    mono: input.mono,
    type: input.type,
    id: `E-${index + 1}`,
    data: input.data
  }));
  const manifest: ExportManifest = {
    protocolVersion: 1,
    createdAt: new Date(0).toISOString(),
    mode: "full",
    site: { origin: "https://app.example.com" },
    chunkCodec: "none",
    redactionProfile: {
      redactHeaders: [],
      redactCookieNames: [],
      redactBodyPatterns: [],
      blockedSelectors: [],
      hashSensitiveValues: true
    },
    stats: { eventCount: events.length, chunkCount: 1, blobCount: 0, durationMs: 40_000 },
    ...manifestPatch
  };

  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index/time.json", "[]");
  zip.file("index/req.json", "[]");
  zip.file("index/inv.json", "[]");
  zip.file("events/chunk-000001.ndjson", events.map((event) => JSON.stringify(event)).join("\n"));

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

  return WebBlackboxPlayer.open(await zip.generateAsync({ type: "uint8array" }));
}

function createClock(): (step?: number) => number {
  let mono = 0;

  return (step = 10) => {
    mono += step;
    return mono;
  };
}

function exchange(
  at: () => number,
  reqId: string,
  options: {
    url?: string;
    method?: string;
    mimeType?: string;
    status?: number;
    request?: Record<string, unknown>;
  } = {}
): EventInput[] {
  return [
    {
      type: "network.request",
      mono: at(),
      data: {
        requestId: reqId,
        request: {
          url: options.url ?? `https://app.example.com/api/${reqId}`,
          method: options.method ?? "GET",
          headers: {},
          ...options.request
        }
      }
    },
    {
      type: "network.response",
      mono: at(),
      data: {
        requestId: reqId,
        response: {
          status: options.status ?? 200,
          mimeType: options.mimeType ?? "application/json"
        }
      }
    },
    { type: "network.finished", mono: at(), data: { requestId: reqId } }
  ];
}

const META_CONFIG: EventInput = {
  type: "meta.config",
  mono: 0,
  data: { capturePolicy: { categories: { network: "body-allowlist" } } }
};

describe("capture completeness", () => {
  it("separates captured, explained and silently missing bodies", async () => {
    const at = createClock();
    const player = await openArchive([
      META_CONFIG,
      ...exchange(at, "kept"),
      { type: "network.body", mono: at(), data: { reqId: "kept", contentHash: "a".repeat(64) } },
      ...exchange(at, "big", { mimeType: "text/javascript" }),
      {
        type: "network.body.skipped",
        mono: at(),
        data: { reqId: "big", side: "response", reason: "too-large", size: 5e6, limit: 1e6 }
      },
      ...exchange(at, "lost", { mimeType: "text/plain" }),
      ...exchange(at, "image", { mimeType: "image/png" }),
      ...exchange(at, "empty", { status: 204 }),
      ...exchange(at, "ext", {
        url: "chrome-extension://abc/content.js",
        mimeType: "text/javascript"
      }),
      ...exchange(at, "blob", { method: "POST", request: { hasPostData: true } }),
      ...exchange(at, "sent", {
        method: "POST",
        request: { hasPostData: true, postData: '{"a":1}' }
      }),
      ...exchange(at, "stream", {
        method: "POST",
        request: { hasPostData: true, postDataSkipped: "unavailable" }
      }),
      ...exchange(at, "upload", {
        method: "POST",
        request: { hasPostData: true, headers: { "content-type": "application/octet-stream" } }
      })
    ]);

    const report = player.getCaptureCompleteness();
    const waterfall = player.getNetworkWaterfall();

    expect(report.bodiesRequested).toBe(true);
    expect(report.network.internalRequests).toBe(1);
    // kept, big, lost and the four POSTs answered with JSON; image, 204 and the extension are out.
    expect(report.network.responseBodies).toMatchObject({
      expected: 7,
      captured: 1,
      skipped: 1,
      missing: 5,
      skipReasons: { "too-large": 1 }
    });
    expect(report.network.responseBodies.byMime["text/javascript"]).toEqual({
      expected: 1,
      captured: 0,
      skipped: 1,
      missing: 0
    });
    expect(report.network.requestBodies).toMatchObject({
      expected: 3,
      captured: 1,
      skipped: 1,
      missing: 1,
      skipReasons: { unavailable: 1 }
    });
    expect(report.network.requestBodies.missingSamples.map((sample) => sample.reqId)).toEqual([
      "blob"
    ]);
    expect(waterfall.find((entry) => entry.reqId === "big")?.responseBodySkip).toEqual({
      reason: "too-large",
      size: 5e6,
      limit: 1e6,
      detail: undefined
    });
    expect(waterfall.find((entry) => entry.reqId === "stream")?.requestBodySkipReason).toBe(
      "unavailable"
    );
    expect(player.generateBugReport()).toContain("response body: too-large");
    expect(formatCaptureCompletenessReport(report).join("\n")).toContain(
      "missing body: GET 200 text/plain https://app.example.com/api/lost"
    );
  });

  it("keeps the stored and the whole size of a body cut at the limit", async () => {
    const at = createClock();
    const player = await openArchive([
      META_CONFIG,
      ...exchange(at, "cut", { mimeType: "text/javascript" }),
      {
        type: "network.body",
        mono: at(),
        data: {
          reqId: "cut",
          contentHash: "c".repeat(64),
          size: 2_600_000,
          sampledSize: 1_048_576,
          truncated: true
        }
      }
    ]);

    expect(player.getNetworkWaterfall()[0]).toMatchObject({
      responseBodySize: 2_600_000,
      responseBodySampledSize: 1_048_576,
      responseBodyTruncated: true
    });
    expect(player.getCaptureCompleteness().network.responseBodies.truncated).toBe(1);
  });

  it("expects SVG bodies, not data: URL bodies, and explains earlier requests", async () => {
    const at = createClock();
    const player = await openArchive([
      META_CONFIG,
      ...exchange(at, "icon", {
        url: "https://app.example.com/img/icon.svg",
        mimeType: "image/svg+xml"
      }),
      ...exchange(at, "inline", {
        url: "data:image/svg+xml;base64,PHN2Zy8+",
        mimeType: "image/svg+xml"
      }),
      // Sent before the capture began: only its response and the skip are in the archive.
      ...exchange(at, "early", { mimeType: "text/javascript" }).slice(1),
      {
        type: "network.body.skipped",
        mono: at(),
        data: { reqId: "early", side: "response", reason: "started-before-capture" }
      }
    ]);

    const report = player.getCaptureCompleteness();

    expect(report.network.responseBodies).toMatchObject({
      expected: 2,
      captured: 0,
      skipped: 1,
      missing: 1,
      dataUrls: 1,
      skipReasons: { "started-before-capture": 1 }
    });
    expect(report.network.responseBodies.missingSamples.map((sample) => sample.reqId)).toEqual([
      "icon"
    ]);
    expect(formatCaptureCompletenessReport(report)[1]).toContain("; 1 in data: URLs");
  });

  it("reads one media type from a Content-Type header sent twice", async () => {
    const at = createClock();
    const player = await openArchive([
      META_CONFIG,
      ...exchange(at, "twice", {
        method: "POST",
        mimeType: "application/json, application/json",
        request: {
          hasPostData: true,
          postData: '{"a":1}',
          headers: { "content-type": "application/json, application/json" }
        }
      }),
      ...exchange(at, "binary", {
        method: "POST",
        request: {
          hasPostData: true,
          headers: { "content-type": "application/octet-stream, application/json" }
        }
      })
    ]);

    const report = player.getCaptureCompleteness();

    expect(Object.keys(report.network.responseBodies.byMime)).toEqual(["application/json"]);
    expect(report.network.requestBodies).toMatchObject({ expected: 1, captured: 1, missing: 0 });
  });

  it("measures how much of the session the DOM events cover", async () => {
    const player = await openArchive([
      META_CONFIG,
      { type: "dom.snapshot", mono: 1_000, data: { reason: "start" } },
      { type: "dom.mutation.batch", mono: 5_000, data: { count: 3 } },
      { type: "dom.snapshot", mono: 9_000, data: { reason: "mutation" } },
      { type: "dom.rrweb.event", mono: 9_100, data: {} },
      { type: "perf.vitals", mono: 9_500, data: { metric: "layout-shift" } },
      // Accessibility snapshots are counted apart: they are not DOM changes.
      { type: "dom.a11y.snapshot", mono: 12_000, data: { truncated: true, droppedTriggers: 2 } },
      { type: "dom.a11y.snapshot", mono: 15_000, data: { truncated: false } },
      { type: "user.marker", mono: 20_000, data: {} }
    ]);

    const { dom, perf } = player.getCaptureCompleteness();

    expect(dom).toEqual({
      snapshots: 2,
      mutationBatches: 1,
      rrwebEvents: 1,
      snapshotReasons: { start: 1, mutation: 1 },
      coverage: (9_100 - 1_000) / 20_000,
      longestGapMs: 20_000 - 9_100,
      a11ySnapshots: 2,
      a11yTruncated: 1,
      a11yDroppedTriggers: 2
    });
    expect(formatCaptureCompletenessReport(player.getCaptureCompleteness())).toContain(
      "Accessibility snapshots: 2 (1 cut, 2 triggers over the per-minute cap)"
    );
    expect(perf.vitals).toBe(1);
  });

  it("counts storage values and IndexedDB records", async () => {
    const player = await openArchive([
      META_CONFIG,
      {
        type: "storage.cookie.snapshot",
        mono: 10,
        data: { cookies: [{ name: "sid", value: "abc" }, { name: "flag" }] }
      },
      {
        type: "storage.idb.snapshot",
        mono: 20,
        data: {
          databases: [
            { name: "app", stores: [{ name: "kv", records: [{ key: "1", value: "x" }] }] }
          ]
        }
      }
    ]);

    expect(player.getCaptureCompleteness().storage).toMatchObject({
      cookieSnapshots: 1,
      cookieValues: 1,
      idbSnapshots: 1,
      idbRecords: 1
    });
  });

  it("reports an older archive as not recording what its export left out", async () => {
    const report = (await openArchive([META_CONFIG])).getCaptureCompleteness();

    expect(report.export).toEqual({
      recorded: false,
      whole: false,
      storedEvents: null,
      exportedEvents: 1,
      truncations: [],
      interruption: null
    });
    expect(formatCaptureCompletenessReport(report)).toContain(
      "Export: 1 events (archive does not record what the export left out)"
    );
  });

  it("reports a whole export of a recording that ended with Stop", async () => {
    const report = (
      await openArchive([META_CONFIG], {
        completeness: { storedEvents: 1, storedChunks: 1, truncations: [] }
      })
    ).getCaptureCompleteness();

    expect(report.export).toMatchObject({ recorded: true, whole: true, storedEvents: 1 });
    expect(formatCaptureCompletenessReport(report)).toContain(
      "Export: 1/1 stored events (whole session)"
    );
  });

  it("reports what the export left out and an interrupted recording", async () => {
    const truncation = {
      reason: "recent-window" as const,
      events: 40,
      chunks: 2,
      fromT: Date.UTC(2026, 0, 1, 10, 0, 0),
      toT: Date.UTC(2026, 0, 1, 10, 20, 0),
      limit: 600_000
    };
    const interruption = {
      reason: "service-worker-restart" as const,
      detectedAt: Date.UTC(2026, 0, 1, 11, 0, 0),
      lastSeenAt: Date.UTC(2026, 0, 1, 10, 59, 30)
    };
    const player = await openArchive([META_CONFIG], {
      completeness: { storedEvents: 41, storedChunks: 3, truncations: [truncation], interruption }
    });
    // The export section describes the whole archive, whatever the range asked for.
    const report = player.getCaptureCompleteness({ monoStart: 5, monoEnd: 6 });
    const lines = formatCaptureCompletenessReport(report);

    expect(report.export).toEqual({
      recorded: true,
      whole: false,
      storedEvents: 41,
      exportedEvents: 1,
      truncations: [truncation],
      interruption
    });
    expect(lines).toContain("Export: 1/41 stored events");
    expect(lines).toContain(
      "  left out (recent-window): 40 events, 2 chunks, 2026-01-01T10:00:00.000Z – " +
        "2026-01-01T10:20:00.000Z, limit 600000"
    );
    expect(lines).toContain(
      "Interrupted: recording ended without Stop (service-worker-restart), noticed " +
        "2026-01-01T11:00:00.000Z, last seen 2026-01-01T10:59:30.000Z"
    );
  });

  it("reads the export record from a manifest alone", () => {
    expect(readExportCompleteness(undefined, 7)).toMatchObject({
      recorded: false,
      exportedEvents: 7
    });
    expect(
      readExportCompleteness({
        stats: { eventCount: 3, chunkCount: 1, blobCount: 0, durationMs: 1 },
        completeness: { storedEvents: 3, storedChunks: 1, truncations: [] }
      })
    ).toMatchObject({ recorded: true, whole: true, storedEvents: 3, exportedEvents: 3 });
  });
});
