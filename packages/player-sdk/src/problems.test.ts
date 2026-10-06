import type { WebBlackboxEvent } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  groupProblems,
  isProblemEvent,
  isProblemRequest,
  listProblemOccurrences,
  readConsoleLevel,
  readEventResourceUrl,
  type ProblemRequest
} from "./problems.js";

const ORIGIN = "https://app.example.test/";

function event(
  id: string,
  type: string,
  mono: number,
  data: Record<string, unknown> = {},
  lvl?: WebBlackboxEvent["lvl"]
): WebBlackboxEvent {
  return {
    v: 1,
    sid: "S-1",
    tab: 1,
    t: mono,
    mono,
    type,
    id,
    data,
    ...(lvl ? { lvl } : {})
  } as WebBlackboxEvent;
}

function request(
  reqId: string,
  url: string,
  startMono: number,
  extra: Partial<ProblemRequest> = {}
): ProblemRequest {
  return { reqId, url, startMono, failed: false, eventIds: [`req-${reqId}`], ...extra };
}

function requestEvents(requests: readonly ProblemRequest[]): WebBlackboxEvent[] {
  return requests.map((entry) =>
    event(`req-${entry.reqId}`, "network.request", entry.startMono, { reqId: entry.reqId })
  );
}

describe("readConsoleLevel / isProblemEvent", () => {
  it("reads the console level from data.level before lvl", () => {
    expect(readConsoleLevel(event("c1", "console.entry", 1, { level: "ERROR" }, "info"))).toBe(
      "error"
    );
    expect(readConsoleLevel(event("c2", "console.entry", 1, {}, "warn"))).toBe("warn");
    expect(readConsoleLevel(event("c3", "console.entry", 1))).toBeNull();
    expect(readConsoleLevel(event("n1", "network.request", 1, { level: "error" }))).toBeNull();
  });

  it("counts console errors and asserts, error events and error-level events", () => {
    expect(isProblemEvent(event("c1", "console.entry", 1, { level: "error" }))).toBe(true);
    expect(isProblemEvent(event("c2", "console.entry", 1, { level: "assert" }))).toBe(true);
    expect(isProblemEvent(event("c3", "console.entry", 1, { level: "warn" }))).toBe(false);
    expect(isProblemEvent(event("e1", "error.exception", 1))).toBe(true);
    expect(isProblemEvent(event("x1", "storage.local.op", 1, {}, "error"))).toBe(true);
    expect(isProblemEvent(event("x2", "network.request", 1))).toBe(false);
  });

  it("does not count a cancelled load logged by the browser", () => {
    const cancelled = event("c4", "console.entry", 1, {
      level: "error",
      text: "Failed to load resource: net::ERR_ABORTED",
      url: "https://app.example.test/prefetch.js"
    });
    expect(isProblemEvent(cancelled)).toBe(false);
    expect(groupProblems({ events: [cancelled], requests: [], firstPartyUrl: ORIGIN })).toEqual([]);
  });
});

describe("isProblemRequest", () => {
  it("flags HTTP errors and network failures, but not cancels", () => {
    expect(isProblemRequest(request("1", ORIGIN, 1, { status: 401 }))).toBe(true);
    expect(isProblemRequest(request("2", ORIGIN, 1, { status: 304 }))).toBe(false);
    expect(
      isProblemRequest(request("3", ORIGIN, 1, { failed: true, errorText: "net::ERR_FAILED" }))
    ).toBe(true);
    expect(
      isProblemRequest(
        request("4", ORIGIN, 1, { status: 204, failed: true, errorText: "net::ERR_ABORTED" })
      )
    ).toBe(false);
    expect(isProblemRequest(request("5", ORIGIN, 1, { failed: true }))).toBe(true);
  });
});

describe("readEventResourceUrl", () => {
  it("reads the URL, the request URL, the script file name or nothing", () => {
    expect(readEventResourceUrl(event("a", "network.ws.open", 1, { url: "wss://x.test/" }))).toBe(
      "wss://x.test/"
    );
    expect(
      readEventResourceUrl(event("b", "network.request", 1, { request: { url: "https://y/" } }))
    ).toBe("https://y/");
    expect(
      readEventResourceUrl(event("c", "error.exception", 1, { filename: "https://z/app.js" }))
    ).toBe("https://z/app.js");
    expect(readEventResourceUrl(event("d", "console.entry", 1, { text: "hi" }))).toBeNull();
  });
});

describe("groupProblems", () => {
  const requests: ProblemRequest[] = [
    request("a1", "https://app.example.test/gw/bff/tournaments/1/active?x=1", 9420, {
      status: 401
    }),
    request("a2", "https://app.example.test/gw/bff/users/casino-user", 10890, { status: 401 }),
    request("a3", "https://app.example.test/gw/bff/chats/rules/64", 11440, { status: 401 }),
    request("n1", "https://app.example.test/assets/resources/undefined", 9770, { status: 404 }),
    request("f1", "https://www.clarity.ms/tag/abc", 1910, {
      failed: true,
      errorText: "net::ERR_ADDRESS_INVALID"
    }),
    request("f2", "https://www.google-analytics.com/g/collect", 1920, {
      failed: true,
      errorText: "net::ERR_ADDRESS_INVALID"
    }),
    request("r1", "https://cdn.example.test/a.png", 9800, {
      failed: true,
      errorText: "net::ERR_CONNECTION_RESET"
    }),
    request("r2", "https://cdn.example.test/b.png", 9810, {
      failed: true,
      errorText: "net::ERR_CONNECTION_RESET"
    }),
    request("x1", "https://www.google.com/g/collect", 1930, {
      status: 204,
      failed: true,
      errorText: "net::ERR_ABORTED"
    }),
    request("ok", "https://app.example.test/api/ok", 500, { status: 200 })
  ];
  const events: WebBlackboxEvent[] = [
    ...requestEvents(requests),
    event("c-linked", "console.entry", 1911, {
      level: "error",
      text: "Failed to load resource: net::ERR_ADDRESS_INVALID",
      url: "https://www.clarity.ms/tag/abc",
      networkRequestId: "f1"
    }),
    event("c-orphan", "console.entry", 2000, {
      level: "error",
      text: "Failed to load resource: the server responded with a status of 500 ()",
      url: "https://app.example.test/api/lost",
      networkRequestId: "not-recorded"
    }),
    event("c-before", "console.entry", 1800, {
      level: "error",
      text: "Failed to load resource: net::ERR_ADDRESS_INVALID",
      url: "https://www.clarity.ms/tag/abc",
      networkRequestId: "logged-before-recording"
    }),
    event("ex1", "error.exception", 10910, {
      message: "AuthError: casino-user request rejected (401 'abc')\n  at ensure",
      stackTop: "ensureCasinoUser @ https://app.example.test/assets/ensure-casino-user.js:57:3"
    }),
    event("ex2", "error.exception", 12000, {
      message: "AuthError: casino-user request rejected (403 'xyz')"
    }),
    event("ex3", "error.unhandledrejection", 12500, {
      message: "TypeError: x is undefined\n    at render (https://app.example.test/js/view.js:4:18)"
    }),
    event("tp", "console.entry", 3000, {
      level: "error",
      text: "widget crashed",
      url: "https://widgets.other.test/w.js"
    }),
    event("warn", "console.entry", 3100, { level: "warn", text: "deprecated" })
  ];
  const groups = groupProblems({ events, requests, firstPartyUrl: ORIGIN });
  const byKey = new Map(groups.map((group) => [group.key, group]));

  it("groups first-party HTTP errors by status and first path segment", () => {
    const auth = byKey.get("http:401:app.example.test/gw");
    expect(auth).toMatchObject({
      category: "auth",
      status: 401,
      reason: "Unauthorized",
      where: "/gw/bff/*",
      count: 3,
      thirdParty: false,
      firstMono: 9420,
      lastMono: 11440
    });
    expect(auth?.occurrences.map((occurrence) => occurrence.reqId)).toEqual(["a1", "a2", "a3"]);
    expect(auth?.occurrences[0]?.eventId).toBe("req-a1");
    expect(byKey.get("http:404:app.example.test/assets")).toMatchObject({
      category: "client",
      reason: "Not Found",
      where: "/assets/resources/undefined",
      count: 1
    });
  });

  it("keeps a recorded status text as the reason", () => {
    const [group] = groupProblems({
      events: [],
      requests: [request("s", ORIGIN, 1, { status: 503, statusText: " Maintenance " })],
      firstPartyUrl: ORIGIN
    });
    expect(group).toMatchObject({ category: "server", reason: "Maintenance", where: "/" });
  });

  it("groups network failures by error, third-party ones across hosts", () => {
    expect(byKey.get("net:ERR_ADDRESS_INVALID:third")).toMatchObject({
      category: "network",
      errorCode: "ERR_ADDRESS_INVALID",
      thirdParty: true,
      where: "",
      hosts: ["www.clarity.ms", "www.google-analytics.com"],
      count: 3
    });
    expect(byKey.get("net:ERR_CONNECTION_RESET:cdn.example.test")).toMatchObject({
      where: "cdn.example.test",
      thirdParty: false,
      count: 2
    });
  });

  it("folds linked console errors into their request and skips cancels", () => {
    const ids = groups.flatMap((group) =>
      group.occurrences.map((occurrence) => occurrence.eventId)
    );
    expect(ids).not.toContain("c-linked");
    expect(ids).not.toContain("req-x1");
    expect(ids).not.toContain("req-ok");
    expect(ids).not.toContain("warn");
    expect(ids).toContain("c-orphan");
  });

  it("files unlinked 'Failed to load resource' lines under their status or net error", () => {
    expect(byKey.get("http:500:app.example.test/api")).toMatchObject({
      category: "server",
      where: "/api/lost",
      occurrences: [{ eventId: "c-orphan", mono: 2000 }]
    });
    expect(byKey.get("net:ERR_ADDRESS_INVALID:third")?.occurrences[0]).toEqual({
      eventId: "c-before",
      mono: 1800
    });
  });

  it("merges a logged error with the exception of the same message", () => {
    const [merged] = groupProblems({
      events: [
        event("log", "console.entry", 1, { level: "error", text: "AuthError: rejected (401)" }),
        event("throw", "error.exception", 2, { message: "AuthError: rejected (401)" })
      ],
      requests: [],
      firstPartyUrl: ORIGIN
    });
    // Logged and thrown at the same moment: one failure, stepped to once (the exception).
    expect(merged).toMatchObject({
      key: "message:autherror: rejected (#)",
      category: "exception",
      count: 1,
      occurrences: [{ eventId: "throw", mono: 2 }]
    });
  });

  it("counts a logged error and a later exception of the same message twice", () => {
    const [merged] = groupProblems({
      events: [
        event("log", "console.entry", 1, { level: "error", text: "AuthError: rejected (401)" }),
        event("throw", "error.exception", 2, { message: "AuthError: rejected (401)" }),
        event("log2", "console.entry", 5000, { level: "error", text: "AuthError: rejected (403)" })
      ],
      requests: [],
      firstPartyUrl: ORIGIN
    });
    expect(merged?.occurrences.map((occurrence) => occurrence.eventId)).toEqual(["throw", "log2"]);
  });

  it("keeps apostrophes inside words when it drops quoted values", () => {
    const groups = groupProblems({
      events: [
        event("a", "console.entry", 1, { level: "error", text: "Don't load A, it's broken" }),
        event("b", "console.entry", 2, { level: "error", text: "Don't load B, it's broken" }),
        event("c", "console.entry", 3, { level: "error", text: "Cannot read 'x' of undefined" }),
        event("d", "console.entry", 4, { level: "error", text: "Cannot read 'y' of undefined" })
      ],
      requests: [],
      firstPartyUrl: ORIGIN
    });
    expect(groups.map((group) => group.count).sort()).toEqual([1, 1, 2]);
  });

  it("files a failed script or image load under its host, unless its request is recorded", () => {
    const failed = request("img", "https://app.example.test/img/a.png", 10, {
      failed: true,
      errorText: "net::ERR_CONNECTION_RESET"
    });
    const groups = groupProblems({
      events: [
        ...requestEvents([failed]),
        event("res1", "error.resource", 11, { tag: "IMG", url: failed.url }),
        event("res2", "error.resource", 20, {
          tag: "SCRIPT",
          url: "https://app.example.test/js/missing.js"
        }),
        event("res3", "error.resource", 30, {
          tag: "LINK",
          url: "https://app.example.test/css/missing.css"
        })
      ],
      requests: [failed],
      firstPartyUrl: ORIGIN
    });
    expect(groups.map((group) => [group.key, group.count])).toEqual([
      ["net:failed:app.example.test", 2],
      ["net:ERR_CONNECTION_RESET:app.example.test", 1]
    ]);
    expect(groups[0]).toMatchObject({ category: "network", errorCode: "failed" });
  });

  it("groups exceptions by message without numbers or quoted values", () => {
    const exception = groups.find((group) => group.category === "exception");
    expect(exception).toMatchObject({
      message: "AuthError: casino-user request rejected (401 'abc')",
      where: "ensure-casino-user.js:57",
      count: 2
    });
  });

  it("finds the script of an exception in its stack", () => {
    expect(groups.find((group) => group.message === "TypeError: x is undefined")).toMatchObject({
      category: "exception",
      where: "view.js:4"
    });
  });

  it("marks console errors from other sites as third-party", () => {
    expect(groups.find((group) => group.message === "widget crashed")).toMatchObject({
      category: "console",
      thirdParty: true,
      hosts: ["widgets.other.test"],
      where: "w.js"
    });
  });

  it("sorts first-party groups first, then by count and first time", () => {
    const order = groups.map((group) => `${group.thirdParty ? "3p" : "1p"}:${group.count}`);
    expect(order).toEqual(["1p:3", "1p:2", "1p:2", "1p:1", "1p:1", "1p:1", "3p:3", "3p:1"]);
    expect(groups[1]?.key).toBe("net:ERR_CONNECTION_RESET:cdn.example.test");
  });

  it("lists every occurrence in time order", () => {
    const monos = listProblemOccurrences(groups).map((occurrence) => occurrence.mono);
    expect(monos).toEqual([...monos].sort((left, right) => left - right));
    expect(monos).toHaveLength(groups.reduce((sum, group) => sum + group.count, 0));
  });

  it("groups third-party HTTP errors by status across hosts", () => {
    const thirdParty = groupProblems({
      events: [],
      requests: [
        request("t1", "https://a.other.test/x", 1, { status: 500, eventIds: ["e1"] }),
        request("t2", "https://b.another.test/y", 2, { status: 500, eventIds: ["e2"] }),
        request("t3", "https://c.another.test/y", 3, { status: 503, eventIds: [] })
      ],
      firstPartyUrl: ORIGIN
    });
    expect(thirdParty).toHaveLength(1);
    expect(thirdParty[0]).toMatchObject({
      key: "http:500:third",
      category: "server",
      where: "",
      count: 2,
      thirdParty: true
    });
  });

  it("shares the path prefix of one segment and names a single third-party host", () => {
    const [first, second] = groupProblems({
      events: [],
      requests: [
        request("p1", "https://app.example.test/api/a", 1, { status: 400 }),
        request("p2", "https://app.example.test/api/b", 2, { status: 400 }),
        request("p3", "https://cdn.other.test/x", 3, { failed: true })
      ],
      firstPartyUrl: ORIGIN
    });
    expect(first).toMatchObject({ where: "/api/*", count: 2 });
    expect(second).toMatchObject({ errorCode: "failed", where: "cdn.other.test" });
  });
});
