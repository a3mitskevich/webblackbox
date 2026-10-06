import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { ExportManifest, WebBlackboxEvent } from "@webblackbox/protocol";

import { formatCaptureCompletenessReport } from "./capture-completeness.js";
import { WebBlackboxPlayer } from "./index.js";

type EventInput = Pick<WebBlackboxEvent, "type" | "data"> & { mono: number };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function openArchive(inputs: EventInput[]): Promise<WebBlackboxPlayer> {
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
    stats: { eventCount: events.length, chunkCount: 1, blobCount: 0, durationMs: 40_000 }
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

  it("measures how much of the session the DOM events cover", async () => {
    const player = await openArchive([
      META_CONFIG,
      { type: "dom.snapshot", mono: 1_000, data: { reason: "start" } },
      { type: "dom.mutation.batch", mono: 5_000, data: { count: 3 } },
      { type: "dom.snapshot", mono: 9_000, data: { reason: "mutation" } },
      { type: "dom.rrweb.event", mono: 9_100, data: {} },
      { type: "perf.vitals", mono: 9_500, data: { metric: "layout-shift" } },
      { type: "user.marker", mono: 20_000, data: {} }
    ]);

    const { dom, perf } = player.getCaptureCompleteness();

    expect(dom).toEqual({
      snapshots: 2,
      mutationBatches: 1,
      rrwebEvents: 1,
      snapshotReasons: { start: 1, mutation: 1 },
      coverage: (9_100 - 1_000) / 20_000,
      longestGapMs: 20_000 - 9_100
    });
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
});
