import { describe, expect, it } from "vitest";

import {
  parseExportDownloadResult,
  parseOffscreenToSwMessage,
  parsePipelineRequest,
  parsePipelineResult,
  parseSwToOffscreenMessage
} from "./offscreen-messages.js";

const SESSION = {
  sid: "S-1",
  tabId: 3,
  startedAt: 1,
  mode: "full",
  url: "https://a.test",
  tags: []
};
const EVENT = { v: 1, sid: "S-1", tab: 3, t: 1, mono: 1, type: "sys.marker", id: "E-1", data: {} };
const SHA = "a".repeat(64);

function request(op: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "sw.pipeline-request", requestId: "R-1", op, sid: "S-1", ...fields };
}

describe("parsePipelineRequest", () => {
  it.each([
    ["start", { session: SESSION }],
    ["ingest", { event: EVENT }],
    ["ingestBatch", { events: [EVENT, EVENT] }],
    ["ingestBatch", { events: [] }],
    ["flush", {}],
    ["putBlob", { mime: "image/png", base64: "AAE=" }],
    ["exportDownload", { passphrase: "secret-pass", includeScreenshots: true }],
    ["close", { purge: true }],
    ["startScreenRecording", { recordingId: "REC-1", streamId: "stream", source: "tab" }],
    ["stopScreenRecording", { recordingId: "REC-1", reason: "stop" }]
  ])("accepts a well-formed %s request", (op, fields) => {
    const parsed = parsePipelineRequest(request(op, fields));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request).toMatchObject({ requestId: "R-1", op, sid: "S-1" });
  });

  it.each([
    ["start", {}, "Missing session metadata for pipeline start."],
    ["start", { session: { sid: "S-1" } }, "Missing session metadata for pipeline start."],
    ["ingest", { event: "nope" }, "Missing event payload for pipeline ingest."],
    ["ingestBatch", { events: [EVENT, 1] }, "Invalid event batch for pipeline ingestBatch."],
    ["putBlob", { base64: "AAE=" }, "Missing mime for blob write."],
    // The old wire form of bytes: a number map is not accepted any more.
    ["putBlob", { mime: "image/png", bytes: { 0: 1 } }, "Missing blob bytes."],
    ["startScreenRecording", { streamId: "s" }, "Missing recording id."],
    ["startScreenRecording", { recordingId: "REC-1" }, "Missing tab capture stream id."],
    ["rewind", {}, "Unsupported pipeline operation: rewind"]
  ])("rejects %s with %j and keeps the request id to answer", (op, fields, error) => {
    expect(parsePipelineRequest(request(op, fields))).toEqual({
      ok: false,
      requestId: "R-1",
      error
    });
  });

  it("rejects a request without a session id", () => {
    expect(parsePipelineRequest(request("flush", { sid: "" }))).toMatchObject({
      ok: false,
      requestId: "R-1"
    });
  });

  it("cannot answer a request without an id", () => {
    expect(parsePipelineRequest({ kind: "sw.pipeline-request", op: "flush", sid: "S-1" })).toEqual({
      ok: false,
      requestId: null,
      error: "Pipeline request without a request id."
    });
  });

  it("keeps only the fields the op defines", () => {
    const parsed = parsePipelineRequest(request("close", { purge: "yes", extra: 1 }));

    expect(parsed.ok && parsed.request).toEqual({
      kind: "sw.pipeline-request",
      requestId: "R-1",
      op: "close",
      sid: "S-1",
      purge: false
    });
  });
});

describe("parseSwToOffscreenMessage", () => {
  it("reads the recording and pipeline status", () => {
    expect(
      parseSwToOffscreenMessage({ kind: "sw.recording-status", active: true, sid: "S" })
    ).toEqual({ kind: "sw.recording-status", active: true });
    expect(
      parseSwToOffscreenMessage({ kind: "sw.pipeline-status", activeSessions: 2, updatedAt: 5 })
    ).toEqual({ kind: "sw.pipeline-status", activeSessions: 2, sessions: [], updatedAt: 5 });
  });

  it("checks the at-rest key message", () => {
    const key = Buffer.alloc(32, 1).toString("base64");

    expect(
      parseSwToOffscreenMessage({ kind: "sw.storage-key", keyId: "a".repeat(16), key })
    ).toMatchObject({ kind: "sw.storage-key" });
    expect(parseSwToOffscreenMessage({ kind: "sw.storage-key", keyId: "x", key })).toBeNull();
  });

  it("ignores unknown and non-object messages", () => {
    expect(parseSwToOffscreenMessage({ kind: "sw.other" })).toBeNull();
    expect(parseSwToOffscreenMessage(null)).toBeNull();
    expect(parseSwToOffscreenMessage("sw.recording-status")).toBeNull();
  });
});

describe("parseOffscreenToSwMessage", () => {
  it("reads responses, defaulting a missing error text", () => {
    expect(
      parseOffscreenToSwMessage({
        kind: "offscreen.pipeline-response",
        requestId: "R",
        ok: true,
        result: 3
      })
    ).toEqual({ kind: "offscreen.pipeline-response", requestId: "R", ok: true, result: 3 });
    expect(
      parseOffscreenToSwMessage({ kind: "offscreen.pipeline-response", requestId: "R", ok: false })
    ).toEqual({
      kind: "offscreen.pipeline-response",
      requestId: "R",
      ok: false,
      error: "Offscreen pipeline request failed."
    });
    expect(parseOffscreenToSwMessage({ kind: "offscreen.pipeline-response", ok: true })).toBeNull();
  });

  it("reads a stored video chunk and normalizes its offsets", () => {
    expect(
      parseOffscreenToSwMessage({
        kind: "offscreen.screen-recording-chunk",
        sid: "S",
        recordingId: "REC",
        index: 2.7,
        mime: "",
        chunkId: SHA,
        size: 10,
        startOffsetMs: -4,
        endOffsetMs: 1_000.4,
        durationMs: "x"
      })
    ).toEqual({
      kind: "offscreen.screen-recording-chunk",
      sid: "S",
      recordingId: "REC",
      index: 2,
      mime: "video/webm",
      chunkId: SHA,
      size: 10,
      startOffsetMs: 0,
      endOffsetMs: 1_000,
      durationMs: 0
    });
  });

  it("drops a chunk that carries bytes instead of a stored chunk id", () => {
    expect(
      parseOffscreenToSwMessage({
        kind: "offscreen.screen-recording-chunk",
        sid: "S",
        recordingId: "REC",
        index: 0,
        bytes: { 0: 1 },
        size: 1
      })
    ).toBeNull();
  });

  it("reads the ended and error notifications", () => {
    expect(
      parseOffscreenToSwMessage({
        kind: "offscreen.screen-recording-ended",
        sid: "S",
        result: { recordingId: "REC", mime: "video/webm", chunkCount: 2, size: 5, durationMs: 9 }
      })
    ).toMatchObject({ sid: "S", result: { recordingId: "REC", chunkCount: 2 } });
    expect(
      parseOffscreenToSwMessage({ kind: "offscreen.screen-recording-ended", sid: "S", result: {} })
    ).toBeNull();
    expect(
      parseOffscreenToSwMessage({
        kind: "offscreen.screen-recording-error",
        sid: "S",
        stage: "chunk"
      })
    ).toEqual({
      kind: "offscreen.screen-recording-error",
      sid: "S",
      recordingId: undefined,
      name: undefined,
      message: "Screen recording failed.",
      stage: "chunk"
    });
  });

  it("reads ready and keepalive, and ignores the rest", () => {
    expect(parseOffscreenToSwMessage({ kind: "offscreen.ready", t: 4 })).toEqual({
      kind: "offscreen.ready",
      t: 4
    });
    expect(
      parseOffscreenToSwMessage({ kind: "offscreen.keepalive", activeSessions: -1, t: 4 })
    ).toEqual({ kind: "offscreen.keepalive", activeSessions: 0, t: 4 });
    expect(parseOffscreenToSwMessage({ kind: "content.events" })).toBeNull();
  });
});

describe("parsePipelineResult", () => {
  it("treats a missing or bad batch size as zero bytes", () => {
    expect(parsePipelineResult("ingestBatch", 120)).toBe(120);
    expect(parsePipelineResult("ingestBatch", -3)).toBe(0);
    expect(parsePipelineResult("ingestBatch", "12")).toBe(0);
  });

  it("requires a content hash from a blob write", () => {
    expect(parsePipelineResult("putBlob", SHA)).toBe(SHA);
    expect(() => parsePipelineResult("putBlob", null)).toThrow("content hash");
  });

  it("returns null for the ops without a result", () => {
    for (const op of ["start", "ingest", "flush", "close"] as const) {
      expect(parsePipelineResult(op, { anything: true })).toBeNull();
    }
  });

  it("checks the screen recording results", () => {
    expect(
      parsePipelineResult("startScreenRecording", {
        recordingId: "REC",
        source: "tab",
        mime: "video/webm",
        width: 1280,
        height: 0,
        audio: false
      })
    ).toEqual({
      recordingId: "REC",
      source: "tab",
      mime: "video/webm",
      width: 1280,
      height: undefined,
      frameRate: undefined,
      audio: false
    });
    expect(() => parsePipelineResult("startScreenRecording", { recordingId: "REC" })).toThrow();
    expect(() => parsePipelineResult("stopScreenRecording", null)).toThrow();
  });
});

describe("parseExportDownloadResult", () => {
  const valid = {
    fileName: "a.webblackbox",
    sizeBytes: 10.4,
    downloadUrl: "blob:x",
    integrity: { manifestSha256: SHA, files: { "a.json": SHA, bad: 1 } },
    privacyScanner: {
      scannedAt: "2026-01-01T00:00:00.000Z",
      preEncryption: true,
      status: "blocked",
      findings: [
        { kind: "jwt", path: "events/0", matchCount: 2, sampleSha256: SHA },
        { kind: "jwt", path: "events/1", matchCount: 1, sampleSha256: "short" },
        { kind: "made-up", path: "events/2", matchCount: 1 },
        { kind: "email", path: "", matchCount: 1 }
      ]
    }
  };

  it("keeps the valid parts of the export payload", () => {
    expect(parseExportDownloadResult(valid)).toEqual({
      fileName: "a.webblackbox",
      sizeBytes: 10,
      downloadUrl: "blob:x",
      downloadId: undefined,
      integrity: { manifestSha256: SHA, files: { "a.json": SHA } },
      privacyScanner: {
        scannedAt: "2026-01-01T00:00:00.000Z",
        preEncryption: true,
        status: "blocked",
        findings: [
          { kind: "jwt", severity: "high", path: "events/0", matchCount: 2, sampleSha256: SHA },
          {
            kind: "jwt",
            severity: "high",
            path: "events/1",
            matchCount: 1,
            sampleSha256: "0".repeat(64)
          }
        ]
      }
    });
  });

  it("refuses a payload without an archive size or download URL", () => {
    expect(() => parseExportDownloadResult(null)).toThrow("Invalid offscreen export payload.");
    expect(() => parseExportDownloadResult({ ...valid, sizeBytes: 0 })).toThrow("archive size");
    expect(() => parseExportDownloadResult({ ...valid, downloadUrl: "" })).toThrow("download URL");
  });

  it("drops a scanner result with an unknown status", () => {
    expect(
      parseExportDownloadResult({ ...valid, privacyScanner: { status: "maybe" } }).privacyScanner
    ).toBeUndefined();
  });
});
