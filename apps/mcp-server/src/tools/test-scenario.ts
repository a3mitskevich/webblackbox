import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { fixtureBlob, fixtureEvent, type FixtureBlob } from "./test-archive.js";

/**
 * Test-only "checkout fails" session: a click on Pay now posts JSON, gets a 500 with a JSON
 * body, logs an error, throws, mutates the DOM and is screenshotted; a WebSocket chats later.
 */

export const PAY_RESPONSE_BODY = JSON.stringify({ error: "card_declined", retry: false });
export const SCREENSHOT_BEFORE = fixtureBlob(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1]), "webp");
export const SCREENSHOT_AFTER = fixtureBlob(new Uint8Array([0x52, 0x49, 0x46, 0x46, 2, 3]), "webp");
export const PAY_BODY_BLOB = fixtureBlob(PAY_RESPONSE_BODY, "json");
export const WS_FRAME_COUNT = 30;

export function checkoutScenario(): { events: WebBlackboxEvent[]; blobs: FixtureBlob[] } {
  const act = { act: "A-1" };
  const pay = { act: "A-1", req: "R-1" };
  const events: WebBlackboxEvent[] = [
    fixtureEvent("E-1", "meta.session.start", 0),
    fixtureEvent("E-2", "nav.commit", 10, { url: "https://shop.example/cart" }),
    fixtureEvent("E-3", "screen.screenshot", 100, {
      shotId: SCREENSHOT_BEFORE.hash,
      format: "webp",
      reason: "navigation",
      size: SCREENSHOT_BEFORE.bytes.byteLength,
      viewport: { width: 1280, height: 720, dpr: 1 }
    }),
    fixtureEvent("E-4", "user.mousemove", 500, { x: 40, y: 30 }),
    fixtureEvent(
      "E-5",
      "user.click",
      1_000,
      {
        x: 50,
        y: 35,
        button: 0,
        ctrlKey: true,
        target: {
          tag: "BUTTON",
          idToken: "pay",
          classTokens: ["btn", "primary"],
          selector: "main > form > button:nth-of-type(2)",
          readable: {
            role: "button",
            text: "Pay now",
            testId: "pay-button",
            name: "pay",
            css: '[data-testid="pay-button"]'
          },
          rect: { x: 10, y: 20, w: 100, h: 30 }
        }
      },
      { ref: act, frame: "main" }
    ),
    fixtureEvent("E-6", "user.click.reaction", 1_001, {
      clickMono: 1_000,
      mutated: true,
      latencyMs: 12,
      windowMs: 500
    }),
    fixtureEvent(
      "E-7",
      "network.request",
      1_010,
      {
        requestId: "R-1",
        request: {
          method: "POST",
          url: "https://shop.example/api/pay",
          headers: { "Content-Type": "application/json", "X-Trace": "abc" },
          postData: JSON.stringify({ amount: 42, currency: "EUR" })
        },
        initiator: {
          type: "script",
          stack: {
            callFrames: [
              { functionName: "pay", url: "https://shop.example/app.js", lineNumber: 10 }
            ]
          }
        }
      },
      { ref: pay }
    ),
    fixtureEvent(
      "E-8",
      "network.response",
      1_200,
      {
        requestId: "R-1",
        response: {
          status: 500,
          statusText: "Internal Server Error",
          mimeType: "application/json",
          headers: { "Content-Type": "application/json", "X-Long": "v".repeat(5_000) }
        }
      },
      { ref: pay }
    ),
    fixtureEvent(
      "E-9",
      "network.body",
      1_210,
      { requestId: "R-1", contentHash: PAY_BODY_BLOB.hash, size: PAY_BODY_BLOB.bytes.byteLength },
      { ref: pay }
    ),
    fixtureEvent("E-10", "network.finished", 1_220, { requestId: "R-1" }, { ref: pay }),
    fixtureEvent(
      "E-11",
      "console.entry",
      1_230,
      { level: "error", text: "Payment failed: card_declined" },
      { ref: act }
    ),
    fixtureEvent(
      "E-12",
      "error.exception",
      1_240,
      { message: "TypeError: receipt is undefined" },
      { ref: act, lvl: "error" }
    ),
    fixtureEvent(
      "E-13",
      "dom.mutation.batch",
      1_250,
      { count: 3, summary: { added: 1, removed: 2 } },
      { ref: act }
    ),
    fixtureEvent(
      "E-14",
      "screen.screenshot",
      1_300,
      {
        shotId: SCREENSHOT_AFTER.hash,
        format: "webp",
        reason: "action",
        size: SCREENSHOT_AFTER.bytes.byteLength,
        pointer: { x: 50, y: 35 }
      },
      { ref: act }
    ),
    fixtureEvent(
      "E-15",
      "network.ws.open",
      2_000,
      { requestId: "WS-1", url: "wss://shop.example/live" },
      { ref: { req: "WS-1" } }
    ),
    ...Array.from({ length: WS_FRAME_COUNT }, (_, index) =>
      fixtureEvent(
        `E-WS-${index}`,
        "network.ws.frame",
        2_100 + index * 10,
        {
          requestId: "WS-1",
          direction: index % 2 === 0 ? "sent" : "received",
          frame: {
            opcode: 1,
            payloadLength: 120,
            payloadPreview: JSON.stringify({ seq: index, pad: "y".repeat(100) })
          }
        },
        { ref: { req: "WS-1" } }
      )
    )
  ];

  return { events, blobs: [SCREENSHOT_BEFORE, SCREENSHOT_AFTER, PAY_BODY_BLOB] };
}
