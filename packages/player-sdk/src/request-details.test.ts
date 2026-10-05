import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import { maskSensitiveUrl, readRequestConnection, readRequestTiming } from "./request-details.js";

function event(type: string, mono: number, data: unknown): WebBlackboxEvent {
  return { v: 1, sid: "S", tab: 1, t: mono, mono, type, id: `${type}-${mono}`, data } as never;
}

const REQUEST_SECONDS = 1_000;

describe("readRequestTiming", () => {
  it("builds Chrome's phases from ResourceTiming, with queueing before requestTime", () => {
    const timing = readRequestTiming([
      event("network.request", 0, { timestamp: REQUEST_SECONDS }),
      event("network.response", 80, {
        response: {
          timing: {
            requestTime: REQUEST_SECONDS + 0.004,
            proxyStart: -1,
            proxyEnd: -1,
            dnsStart: 1,
            dnsEnd: 3,
            connectStart: 3,
            connectEnd: 20,
            sslStart: 10,
            sslEnd: 20,
            sendStart: 21,
            sendEnd: 22,
            receiveHeadersEnd: 72
          }
        }
      }),
      event("network.finished", 100, { timestamp: REQUEST_SECONDS + 0.1 })
    ]);
    const phases = Object.fromEntries(
      timing.phases.map((phase) => [phase.name, [phase.startMs, phase.durationMs]])
    );

    expect(timing.source).toBe("resource-timing");
    expect(Object.keys(phases)).toEqual([
      "queueing",
      "stalled",
      "dns",
      "connect",
      "ssl",
      "send",
      "wait",
      "download"
    ]);
    expect(phases.queueing?.[1]).toBeCloseTo(4);
    expect(phases.dns?.[0]).toBeCloseTo(5);
    expect(phases.connect?.[1]).toBeCloseTo(7);
    expect(phases.wait?.[1]).toBeCloseTo(50);
    expect(phases.download?.[1]).toBeCloseTo(24);
    expect(timing.waitingMs).toBeCloseTo(76);
  });

  it("falls back to request → response → end without ResourceTiming", () => {
    expect(
      readRequestTiming([
        event("network.request", 10, {}),
        event("network.response", 40, { response: {} }),
        event("network.failed", 70, {})
      ])
    ).toEqual({
      source: "events",
      waitingMs: 30,
      phases: [
        { name: "wait", startMs: 0, durationMs: 30 },
        { name: "download", startMs: 30, durationMs: 30 }
      ]
    });
    expect(readRequestTiming([])).toEqual({ source: "events", phases: [] });
    expect(readRequestTiming([event("network.request", 1, {})]).phases).toEqual([]);
  });
});

describe("readRequestConnection", () => {
  it("reads the resource type, protocol, address and the initiator stack", () => {
    const info = readRequestConnection([
      event("network.request", 1, {
        type: "Fetch",
        documentURL: "https://a.test/",
        hasUserGesture: false,
        initiator: {
          type: "script",
          stack: {
            callFrames: [
              {
                functionName: "load",
                url: "https://a.test/app.js",
                lineNumber: 4,
                columnNumber: 9
              },
              { url: 12 }
            ],
            parent: { callFrames: [{ functionName: "", url: "https://a.test/vendor.js" }] }
          }
        }
      }),
      event("network.response", 2, {
        response: { protocol: "h2", remoteIPAddress: "10.0.0.1", remotePort: 443 }
      })
    ]);

    expect(info).toEqual({
      resourceType: "Fetch",
      protocol: "h2",
      remoteAddress: "10.0.0.1:443",
      documentUrl: "https://a.test/",
      hasUserGesture: false,
      initiator: {
        type: "script",
        frames: [
          { functionName: "load", url: "https://a.test/app.js", lineNumber: 4, columnNumber: 9 },
          { functionName: "", url: "https://a.test/vendor.js" }
        ]
      }
    });
  });

  it("reads a socket's initiator from its open event and tolerates missing data", () => {
    expect(
      readRequestConnection([
        event("network.ws.open", 1, {
          initiator: { type: "parser", url: "https://a.test/", lineNumber: 3 }
        })
      ])
    ).toEqual({
      initiator: { type: "parser", url: "https://a.test/", lineNumber: 3, frames: [] }
    });
    expect(readRequestConnection([event("network.request", 1, { initiator: "x" })])).toEqual({});
    expect(
      readRequestConnection([
        event("network.response", 1, { response: { remoteIPAddress: "::1" } })
      ])
    ).toEqual({ remoteAddress: "::1" });
  });
});

describe("maskSensitiveUrl", () => {
  it("hides secret query values and names them", () => {
    expect(
      maskSensitiveUrl("wss://a.test/hubs?access_token=eyJhbGci.x.y&clientId=1001&sig=abc")
    ).toEqual({
      url: "wss://a.test/hubs?access_token=…&clientId=1001&sig=…",
      hiddenParams: ["access_token", "sig"]
    });
  });

  it("leaves other URLs and unparseable input alone", () => {
    expect(maskSensitiveUrl("https://a.test/x?q=1&token=")).toEqual({
      url: "https://a.test/x?q=1&token=",
      hiddenParams: []
    });
    expect(maskSensitiveUrl("not a url")).toEqual({ url: "not a url", hiddenParams: [] });
  });
});
