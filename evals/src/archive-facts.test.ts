import { describe, expect, it } from "vitest";

import { factsFromEvents } from "./archive-facts.js";

/** Shapes as the Default profile (Lite) records them: hashed targets, redacted values. */
const LITE_EVENTS = [
  { type: "network.request", data: { reqId: "1", method: "GET", url: "/api/cart" } },
  {
    type: "network.response",
    data: { reqId: "1", status: 200, duration: 3, url: "/api/cart" }
  },
  { type: "network.request", data: { reqId: "2", method: "GET", url: "/api/reports" } },
  {
    type: "user.click",
    data: { target: { tag: "BUTTON", selector: "selector:6b16d796b03a", idToken: "abc" } }
  },
  { type: "user.input", data: { inputType: "text", length: 3, valueRedacted: true } },
  {
    type: "error.exception",
    data: { filename: "/app.js", messageRedacted: true, stackRedacted: true }
  },
  { type: "storage.local.snapshot", data: { count: 1, mode: "counts-only", redacted: true } },
  {
    type: "dom.rrweb.event",
    data: { event: { type: "incremental-snapshot", source: "mutation-summary" } }
  }
];

/** Shapes as Full capture records them (CDP network, readable targets, raw values). */
const FULL_EVENTS = [
  {
    type: "network.request",
    data: {
      requestId: "D1",
      frameId: "MAIN",
      type: "Document",
      request: { url: "/checkout/payment/", method: "GET" }
    }
  },
  {
    type: "network.request",
    data: {
      requestId: "D2",
      frameId: "CHILD",
      type: "Document",
      request: { url: "/widgets/pay/frame.html", method: "GET" }
    }
  },
  {
    type: "network.request",
    data: {
      requestId: "F1",
      frameId: "MAIN",
      type: "Fetch",
      request: { url: "/api/cart", method: "PATCH", hasPostData: true, postData: '{"qty":2}' }
    }
  },
  {
    type: "network.response",
    data: {
      requestId: "F1",
      timestamp: 1,
      response: { status: 200, fromDiskCache: true }
    }
  },
  { type: "network.finished", data: { requestId: "D1" } },
  { type: "network.finished", data: { requestId: "D2" } },
  { type: "network.body", data: { reqId: "F1", mimeType: "application/json" } },
  { type: "network.ws.open", data: { requestId: "W1", url: "ws://x/ws" } },
  { type: "nav.commit", data: { url: "/checkout/payment/" } },
  {
    type: "user.click",
    data: { target: { tag: "BUTTON", readable: { role: "button", text: "Pay", css: "#pay" } } }
  },
  { type: "user.input", data: { inputType: "text", value: "4242" } },
  {
    type: "error.exception",
    data: { message: "ReferenceError: currencyFormatter is not defined" }
  },
  {
    type: "storage.local.snapshot",
    data: { mode: "allow", entries: [{ key: "flagOverrides", value: "{}" }] }
  },
  { type: "dom.snapshot", data: { source: "html" } }
];

describe("factsFromEvents", () => {
  it("reports what a Default (Lite) archive lacks", () => {
    expect(factsFromEvents(LITE_EVENTS)).toEqual({
      "click-target": false,
      dom: false,
      exception: false,
      iframe: false,
      navigation: false,
      "network-cache": false,
      "network-pending": true,
      "network-request-body": false,
      "network-response-body": false,
      "network-status": true,
      "network-timing": true,
      "storage-value": false,
      "user-input": false,
      websocket: false
    });
  });

  it("reports what a Full capture archive holds", () => {
    expect(factsFromEvents(FULL_EVENTS)).toEqual({
      "click-target": true,
      dom: true,
      exception: true,
      iframe: true,
      navigation: true,
      "network-cache": true,
      "network-pending": false,
      "network-request-body": true,
      "network-response-body": true,
      "network-status": true,
      "network-timing": true,
      "storage-value": true,
      "user-input": true,
      websocket: true
    });
  });

  it("treats a full rrweb snapshot as DOM, and a single document frame as no iframe", () => {
    const facts = factsFromEvents([
      { type: "dom.rrweb.event", data: { event: { type: 2 } } },
      { type: "network.request", data: { requestId: "A", frameId: "MAIN", type: "Document" } },
      { type: "network.request", data: { requestId: "B", frameId: "MAIN", type: "Document" } }
    ]);

    expect(facts.dom).toBe(true);
    expect(facts.iframe).toBe(false);
  });

  it("does not count a request without a body as having one", () => {
    const facts = factsFromEvents([
      {
        type: "network.request",
        data: { requestId: "A", request: { method: "POST", hasPostData: true } }
      }
    ]);

    expect(facts["network-request-body"]).toBe(false);
  });
});
