import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  maskSensitiveUrl,
  readRequestConnection,
  readRequestTiming,
  URL_USERINFO_MARKER
} from "./request-details.js";

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

  it("counts ResourceTiming from the last redirect hop, not the first request", () => {
    const timing = readRequestTiming([
      event("network.request", 0, { timestamp: REQUEST_SECONDS }),
      event("network.request", 30, { timestamp: REQUEST_SECONDS + 0.03 }),
      event("network.response", 60, {
        response: {
          timing: {
            requestTime: REQUEST_SECONDS + 0.031,
            sendStart: 1,
            sendEnd: 2,
            receiveHeadersEnd: 20
          }
        }
      }),
      event("network.finished", 70, { timestamp: REQUEST_SECONDS + 0.06 }),
      event("network.request", 90, { timestamp: REQUEST_SECONDS + 0.09 })
    ]);
    const queueing = timing.phases.find((phase) => phase.name === "queueing");

    expect(timing.source).toBe("resource-timing");
    expect(queueing?.durationMs).toBeCloseTo(1);
    expect(timing.waitingMs).toBeCloseTo(21);
  });

  it("falls back to the events when ResourceTiming starts before the request (cache, worker)", () => {
    const timing = readRequestTiming([
      event("network.request", 0, { timestamp: REQUEST_SECONDS }),
      event("network.response", 4, {
        response: {
          timing: {
            requestTime: REQUEST_SECONDS - 5,
            sendStart: 0,
            sendEnd: 0,
            receiveHeadersEnd: 1
          }
        }
      }),
      event("network.finished", 10, { timestamp: REQUEST_SECONDS + 0.01 })
    ]);

    expect(timing).toEqual({
      source: "events",
      waitingMs: 4,
      phases: [
        { name: "wait", startMs: 0, durationMs: 4 },
        { name: "download", startMs: 4, durationMs: 6 }
      ]
    });
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
    expect(maskSensitiveUrl("")).toEqual({ url: "", hiddenParams: [] });
  });

  it("hides secrets in the fragment (OAuth implicit flow) and in hash-routed queries", () => {
    expect(
      maskSensitiveUrl("https://a.test/cb#access_token=abc&state=1&token_type=Bearer")
    ).toEqual({
      url: "https://a.test/cb#access_token=…&state=1&token_type=…",
      hiddenParams: ["access_token", "token_type"]
    });
    expect(maskSensitiveUrl("https://a.test/?token=1#/login?token=2&next=%2Fhome")).toEqual({
      url: "https://a.test/?token=…#/login?token=…&next=%2Fhome",
      hiddenParams: ["token"]
    });
    expect(maskSensitiveUrl("https://a.test/docs#section-2")).toEqual({
      url: "https://a.test/docs#section-2",
      hiddenParams: []
    });
  });

  it("hides the userinfo of the authority", () => {
    expect(maskSensitiveUrl("https://user:pa%40ss@a.test:8443/x?q=1")).toEqual({
      url: "https://…@a.test:8443/x?q=1",
      hiddenParams: [URL_USERINFO_MARKER]
    });
    expect(maskSensitiveUrl("wss://ghp_secret@a.test/hub")).toEqual({
      url: "wss://…@a.test/hub",
      hiddenParams: [URL_USERINFO_MARKER]
    });
    // An `@` in the path or the query is not userinfo.
    expect(maskSensitiveUrl("https://a.test/u/@me?mail=a@b.test").url).toBe(
      "https://a.test/u/@me?mail=a@b.test"
    );
  });

  it("masks relative and scheme-less URLs", () => {
    expect(maskSensitiveUrl("/hub?access_token=x&id=2")).toEqual({
      url: "/hub?access_token=…&id=2",
      hiddenParams: ["access_token"]
    });
    expect(maskSensitiveUrl("a.test/hub?sig=1")).toEqual({
      url: "a.test/hub?sig=…",
      hiddenParams: ["sig"]
    });
  });

  it("catches key, authorization, bearer and one-time-password names, not words ending in key", () => {
    const names = [
      "access_key",
      "AccessKey",
      "private_key",
      "privateKey",
      "client-key",
      "authorization",
      "bearer",
      "otp",
      "totp",
      "otp_code",
      "X-Amz-Credential"
    ];
    const keptNames = ["keyword", "monkey", "turnkey", "hotkeys", "keys", "notpad", "spotprice"];
    const query = (list: string[]) => list.map((name) => `${name}=v`).join("&");

    expect(maskSensitiveUrl(`https://a.test/?${query(names)}`).hiddenParams).toEqual(names);
    expect(maskSensitiveUrl(`https://a.test/?${query(keptNames)}`).hiddenParams).toEqual([]);
  });

  it("leaves everything but the secret values byte-identical", () => {
    expect(
      maskSensitiveUrl("https://a.test/p%C3%A4th?q=a%20b+c&plus=%2B&token=x%2By&flag&e=")
    ).toEqual({
      url: "https://a.test/p%C3%A4th?q=a%20b+c&plus=%2B&token=…&flag&e=",
      hiddenParams: ["token"]
    });
    // Encoded names are matched decoded and listed once.
    expect(maskSensitiveUrl("https://a.test/?api%5Fkey=1&api_key=2")).toEqual({
      url: "https://a.test/?api%5Fkey=…&api_key=…",
      hiddenParams: ["api_key"]
    });
  });
});
