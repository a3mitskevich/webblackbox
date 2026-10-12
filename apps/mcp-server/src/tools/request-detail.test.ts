import { WebBlackboxPlayer } from "@webblackbox/player-sdk";
import { beforeAll, describe, expect, it } from "vitest";

import type { BodyView } from "./body-view.js";
import { buildRequestDetail } from "./request-detail.js";
import { buildArchiveBytes, fixtureBlob, fixtureEvent } from "./test-archive.js";
import { checkoutScenario, PAY_RESPONSE_BODY, WS_FRAME_COUNT } from "./test-scenario.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_BLOB = fixtureBlob(PNG_BYTES, "png");
const CUT_BLOB = fixtureBlob('{"items":[1,2,3', "json");

let player: WebBlackboxPlayer;

function request(id: string, reqId: string, mono: number, url: string, postData?: string) {
  return fixtureEvent(
    id,
    "network.request",
    mono,
    { requestId: reqId, request: { method: postData ? "POST" : "GET", url, postData } },
    { ref: { req: reqId } }
  );
}

function response(id: string, reqId: string, mono: number, mimeType: string) {
  return fixtureEvent(
    id,
    "network.response",
    mono,
    { requestId: reqId, response: { status: 200, mimeType } },
    { ref: { req: reqId } }
  );
}

beforeAll(async () => {
  const { events, blobs } = checkoutScenario();
  const extra = [
    request("P-1", "R-2", 3_000, "https://shop.example/logo.png"),
    response("P-2", "R-2", 3_010, "image/png"),
    fixtureEvent(
      "P-3",
      "network.body",
      3_011,
      { requestId: "R-2", contentHash: PNG_BLOB.hash, size: PNG_BYTES.byteLength },
      { ref: { req: "R-2" } }
    ),
    request("P-4", "R-3", 3_100, "https://shop.example/video.mp4"),
    response("P-5", "R-3", 3_110, "video/mp4"),
    fixtureEvent(
      "P-6",
      "network.body.skipped",
      3_111,
      { reqId: "R-3", side: "response", reason: "too-large", size: 9_000_000, limit: 1_048_576 },
      { ref: { req: "R-3" } }
    ),
    request("P-7", "R-4", 3_200, "https://shop.example/api/items"),
    response("P-8", "R-4", 3_210, "application/json"),
    fixtureEvent(
      "P-9",
      "network.body",
      3_211,
      {
        requestId: "R-4",
        contentHash: CUT_BLOB.hash,
        size: 5_000,
        sampledSize: CUT_BLOB.bytes.byteLength,
        truncated: true
      },
      { ref: { req: "R-4" } }
    ),
    request("P-10", "R-5", 3_300, "https://shop.example/api/upload", "x".repeat(2_000)),
    request("P-11", "R-6", 3_400, `data:image/png;base64,${"A".repeat(20_000)}`)
  ];
  player = await WebBlackboxPlayer.open(
    await buildArchiveBytes([...events, ...extra], [...blobs, PNG_BLOB, CUT_BLOB])
  );
});

describe("request_detail", () => {
  it("returns method, status, headers, timing, initiator and the linked action", async () => {
    const { data } = await buildRequestDetail(player, "a", { requestId: "R-1" });

    expect(data.request).toMatchObject({
      requestId: "R-1",
      method: "POST",
      url: "https://shop.example/api/pay",
      status: 500,
      durationMs: 210
    });
    expect(data.requestHeaders).toEqual({ "content-type": "application/json", "x-trace": "abc" });
    expect(data.timing).toMatchObject({ source: "events", waitingMs: 190 });
    expect(data.initiator).toMatchObject({
      type: "script",
      frames: { total: 1, items: [{ functionName: "pay", lineNumber: 10 }] }
    });
    expect(data.linkedAction).toEqual({
      actionId: "A-1",
      triggerEventId: "E-5",
      startMono: 1_000,
      offsetMs: 10
    });
    expect(data.actionByTime).toEqual(data.linkedAction);
  });

  it("decodes and pretty-prints JSON bodies", async () => {
    const { data } = await buildRequestDetail(player, "a", { requestId: "R-1" });
    const requestBody = data.requestBody as BodyView;

    expect(requestBody).toMatchObject({ present: true, kind: "json", truncated: false });
    expect(JSON.parse(requestBody.text ?? "")).toEqual({ amount: 42, currency: "EUR" });
    expect(data.responseBody).toMatchObject({
      present: true,
      kind: "json",
      storedBytes: PAY_RESPONSE_BODY.length,
      capturedPrefixOnly: false,
      text: JSON.stringify(JSON.parse(PAY_RESPONSE_BODY), null, 2)
    });
  });

  it("cuts a body at maxBodyBytes and long header values, saying 'N of M bytes'", async () => {
    const upload = await buildRequestDetail(player, "a", { requestId: "R-5", maxBodyBytes: 300 });
    const pay = await buildRequestDetail(player, "a", { requestId: "R-1", bodies: "response" });

    expect(upload.data.requestBody).toMatchObject({
      truncated: true,
      textBytes: 2_000,
      note: "300 of 2000 bytes",
      text: "x".repeat(300)
    });
    expect(pay.data.requestBody).toBeNull();
    expect((pay.data.responseHeaders as Record<string, string>)["x-long"]).toMatch(
      /… \(2048 of 5000 bytes\)$/
    );
  });

  it("cuts a huge URL such as a data: URL, saying 'N of M bytes'", async () => {
    const inline = await buildRequestDetail(player, "a", { requestId: "R-6", bodies: "none" });
    const url = (inline.data.request as { url: string }).url;

    expect(url.startsWith("data:image/png;base64,AAAA")).toBe(true);
    expect(url).toMatch(/… \(4096 of 20022 bytes\)$/);
    expect(url.length).toBeLessThan(4_200);
  });

  it("flags a body the capture kept only a prefix of", async () => {
    const { data } = await buildRequestDetail(player, "a", { requestId: "R-4" });

    expect(data.responseBody).toMatchObject({
      kind: "text",
      capturedPrefixOnly: true,
      originalBytes: 5_000,
      truncated: false,
      text: '{"items":[1,2,3'
    });
  });

  it("shows binary bodies as a hex preview and says why a body is missing", async () => {
    const image = await buildRequestDetail(player, "a", { requestId: "R-2" });
    const skipped = await buildRequestDetail(player, "a", { requestId: "R-3" });

    expect(image.data.responseBody).toMatchObject({
      kind: "binary",
      text: null,
      hexPreview: Buffer.from(PNG_BYTES).toString("hex")
    });
    expect(image.data.requestBody).toMatchObject({
      present: false,
      missingReason: "The request had no body."
    });
    expect((skipped.data.responseBody as BodyView).missingReason).toBe(
      "Not recorded: too-large (9000000 bytes, limit 1048576)."
    );
  });

  it("pages WebSocket messages with a cursor", async () => {
    const first = await buildRequestDetail(player, "a", { requestId: "WS-1", frameLimit: 10 });
    const frames = first.data.frames as {
      total: number;
      nextCursor: string;
      items: Array<{ eventId: string; payload: string | null; truncated: boolean }>;
    };
    const second = await buildRequestDetail(player, "a", {
      requestId: "WS-1",
      frameLimit: 10,
      frameCursor: frames.nextCursor
    });
    const secondFrames = second.data.frames as {
      offset: number;
      items: Array<{ eventId: string }>;
    };

    expect(frames).toMatchObject({ protocol: "ws", url: "wss://shop.example/live" });
    expect(frames.total).toBe(WS_FRAME_COUNT + 1);
    expect(frames.items).toHaveLength(10);
    expect(frames.items[1]).toMatchObject({ eventId: "E-WS-0", truncated: false });
    expect(secondFrames.offset).toBe(10);
    expect(secondFrames.items[0]?.eventId).toBe("E-WS-9");
    expect(first.data.events).toMatchObject({ total: 1, items: [{ type: "network.ws.open" }] });
  });

  it("cuts long socket messages at maxFrameBytes", async () => {
    const { data } = await buildRequestDetail(player, "a", {
      requestId: "WS-1",
      frameLimit: 2,
      maxFrameBytes: 64
    });
    const frames = data.frames as { items: Array<{ payload: string | null; note: string | null }> };
    const message = frames.items[1];

    expect(message?.payload).toHaveLength(64);
    expect(message?.note).toMatch(/^64 of \d+ bytes$/);
  });

  it("rejects an unknown request id", async () => {
    await expect(buildRequestDetail(player, "a", { requestId: "nope" })).rejects.toThrow(
      /Unknown requestId/
    );
  });
});
